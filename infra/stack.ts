import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Stack, StackProps, CfnOutput, Tags, Duration, CustomResource, SecretValue } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as customresources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { loadConfig } from './config';
import { FoundationResources } from './foundation';

/** Content hash of prisma/migrations — a change re-triggers the migration custom resource on deploy. */
function migrationsHash(): string {
  const root = join(__dirname, '..', 'prisma', 'migrations');
  const hash = createHash('sha256');
  for (const folder of readdirSync(root).sort()) {
    hash.update(folder);
    hash.update(readFileSync(join(root, folder, 'migration.sql')));
  }
  return hash.digest('hex').slice(0, 16);
}

export class ClaqStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);
    const cfg = loadConfig(props.stage);
    const prod = props.stage === 'prod';
    const foundation = new FoundationResources(this, props.stage, cfg);

    // ---------- Auth ----------
    const pool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
    });

    pool.addDomain('Domain', { cognitoDomain: { domainPrefix: `${cfg.domainPrefix}-auth` } });

    const client = pool.addClient('WebAndMobileClient', {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true, userPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.EMAIL],
        callbackUrls: cfg.callbackUrls.length > 0 ? cfg.callbackUrls : ['http://localhost:3000/callback'],
        logoutUrls: cfg.logoutUrls.length > 0 ? cfg.logoutUrls : ['http://localhost:3000/logout'],
      },
    });

    // ---------- SSO: Google ----------
    if (cfg.googleClientId && cfg.googleClientSecret) {
      const google = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
        userPool: pool,
        clientId: cfg.googleClientId,
        clientSecretValue: SecretValue.unsafePlainText(cfg.googleClientSecret),
        scopes: ['openid', 'email', 'profile'],
      });
      client.node.addDependency(google);
    }

    // ---------- SSO: Microsoft (via generic OIDC) ----------
    if (cfg.microsoftClientId && cfg.microsoftClientSecret) {
      const tenantId = cfg.microsoftTenantId ?? 'common';
      const microsoft = new cognito.UserPoolIdentityProviderOidc(this, 'MicrosoftIdp', {
        userPool: pool,
        name: 'Microsoft',
        clientId: cfg.microsoftClientId,
        clientSecret: cfg.microsoftClientSecret,
        issuerUrl: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        scopes: ['openid', 'email', 'profile'],
      });
      client.node.addDependency(microsoft);
    }

    // ---------- SSO: Apple ----------
    if (cfg.appleClientId && cfg.appleTeamId && cfg.appleKeyId && cfg.applePrivateKey) {
      const apple = new cognito.UserPoolIdentityProviderApple(this, 'AppleIdp', {
        userPool: pool,
        clientId: cfg.appleClientId,
        teamId: cfg.appleTeamId,
        keyId: cfg.appleKeyId,
        privateKey: cfg.applePrivateKey,
        scopes: ['name', 'email'],
      });
      client.node.addDependency(apple);
    }

    // ---------- Lambda shared bits ----------
    const baseEnv: Record<string, string> = { APP_ENV: props.stage, DATABASE_URL: foundation.databaseUrl };
    const baseFn = (id: string, asset: string, extra: Partial<lambda.FunctionProps>): lambda.Function =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(`dist/lambdas/${asset}`),
        vpc: foundation.vpc,
        vpcSubnets: foundation.appSubnets,
        securityGroups: [foundation.appSg],
        tracing: lambda.Tracing.ACTIVE,
        logRetention: prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
        ...extra,
      });

    // ---------- Migration runner (custom resource) ----------
    const migratorFn = baseFn('MigrationsRunner', 'migrator', {
      memorySize: 256,
      timeout: Duration.minutes(5),
      description: 'Applies prisma/migrations SQL on deploy (CloudFormation custom resource)',
    });
    foundation.database.secret!.grantRead(migratorFn);
    const migrationProvider = new customresources.Provider(this, 'MigrationsProvider', {
      onEventHandler: migratorFn,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    new CustomResource(this, 'DatabaseMigrations', {
      serviceToken: migrationProvider.serviceToken,
      resourceType: 'Custom::ClaqDatabaseMigration',
      properties: { SecretArn: foundation.database.secret!.secretArn, MigrationHash: migrationsHash() },
    });

    // ---------- API ----------
    const apiFn = baseFn('ApiFunction', 'api', {
      memorySize: 512,
      timeout: Duration.seconds(28),
      environment: {
        ...baseEnv,
        DOCUMENT_BUCKET: foundation.documents.bucketName,
        NOTIFICATION_QUEUE: foundation.queue.queueUrl,
        KMS_KEY_ID: foundation.dataKey.keyId,
        ...(cfg.stripeSecretKey ? { STRIPE_SECRET_KEY: cfg.stripeSecretKey } : {}),
        ...(cfg.stripeWebhookSecret ? { STRIPE_WEBHOOK_SECRET: cfg.stripeWebhookSecret } : {}),
        ...(cfg.stripePriceAccountantOffice ? { STRIPE_PRICE_ACCOUNTANT_OFFICE: cfg.stripePriceAccountantOffice } : {}),
        ...(cfg.stripePricePmeCorporate ? { STRIPE_PRICE_PME_CORPORATE: cfg.stripePricePmeCorporate } : {}),
      },
      description: 'CLAQ HTTP API (Prisma + RLS tenant guard)',
    });
    foundation.documents.grantReadWrite(apiFn);
    foundation.queue.grantSendMessages(apiFn);
    foundation.dataKey.grantEncryptDecrypt(apiFn);

    const api = new apigwv2.HttpApi(this, 'HttpApi', { createDefaultStage: true });
    const jwt = new authorizers.HttpJwtAuthorizer('CognitoJwt', `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`, { jwtAudience: [client.userPoolClientId] });
    api.addRoutes({ path: '/v1/health', methods: [apigwv2.HttpMethod.GET], integration: new integrations.HttpLambdaIntegration('HealthIntegration', apiFn) });
    api.addRoutes({ path: '/v1/billing/webhook', methods: [apigwv2.HttpMethod.POST], integration: new integrations.HttpLambdaIntegration('WebhookIntegration', apiFn) });
    api.addRoutes({ path: '/v1/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration: new integrations.HttpLambdaIntegration('Integration', apiFn), authorizer: jwt });

    // ---------- Reminder scheduler + notifier ----------
    const remindersFn = baseFn('RemindersFunction', 'reminders', {
      memorySize: 512,
      timeout: Duration.minutes(5),
      environment: { ...baseEnv, NOTIFICATION_QUEUE: foundation.queue.queueUrl },
      description: 'Daily reminder planner: statuses, dedup, enqueue',
    });
    foundation.queue.grantSendMessages(remindersFn);
    new events.Rule(this, 'DailyReminderRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '6' }),
      description: 'Daily obligation reminder planning (06:00 UTC)',
      targets: [new targets.LambdaFunction(remindersFn, { retryAttempts: 2 })],
    });

    const notifierFn = baseFn('NotifierFunction', 'notifier', {
      memorySize: 256,
      timeout: Duration.seconds(60),
      environment: {
        ...baseEnv,
        ALERTS_FROM_EMAIL: cfg.alertsFromEmail,
        ...(cfg.whatsappSecretArn ? { WHATSAPP_SECRET_ARN: cfg.whatsappSecretArn } : {}),
      },
      description: 'Sends obligation reminders via email (SES) and WhatsApp',
    });
    foundation.queue.grantConsumeMessages(notifierFn);
    notifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
        // TODO: scope to the verified SES identity once the sending domain is provisioned.
      }),
    );
    new lambda.EventSourceMapping(this, 'NotifierSource', {
      target: notifierFn,
      eventSourceArn: foundation.queue.queueArn,
      batchSize: 10,
      reportBatchItemFailures: true,
    });

    // ---------- Security: WAF on API Gateway ----------
    const webAcl = new wafv2.CfnWebACL(this, 'ApiWaf', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'ClaqApiWaf', sampledRequestsEnabled: true },
      rules: [
        {
          name: 'RateLimit2k',
          priority: 1,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimit', sampledRequestsEnabled: true },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'CommonRuleSet', sampledRequestsEnabled: true },
        },
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesSQLiRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'SqlInjection', sampledRequestsEnabled: true },
        },
      ],
    });
    // WAF association for HTTP APIs is not supported in af-south-1 via CfnWebACLAssociation.
    // WebACL is created; attach via console or switch prod to eu-west-1/us-east-1 when ready.
    // new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
    //   resourceArn: `arn:aws:apigateway:${this.region}::/apis/${api.httpApiId}/stages/$default`,
    //   webAclArn: webAcl.attrArn,
    // });

    // ---------- Security: CloudTrail ----------
    new cloudtrail.Trail(this, 'ManagementTrail', {
      bucket: foundation.trailLogs,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });

    // ---------- Security: GuardDuty ----------
    new guardduty.CfnDetector(this, 'GuardDuty', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
    });

    // ---------- Security: Security Hub ----------
    new securityhub.CfnHub(this, 'SecurityHub', {
      autoEnableControls: true,
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'DocumentBucket', { value: foundation.documents.bucketName });
    new CfnOutput(this, 'DatabaseSecretArn', { value: foundation.database.secret!.secretArn });
    new CfnOutput(this, 'DemoBanner', { value: String(cfg.demoBanner) });

    Tags.of(this).add('System', 'CLAQ');
    Tags.of(this).add('Environment', props.stage);
  }
}
