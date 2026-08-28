import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { StageConfig } from './config';

/** Network, encryption, storage, queueing and the PostgreSQL instance. */
export class FoundationResources {
  readonly vpc: ec2.Vpc;
  readonly appSubnets: ec2.SubnetSelection;
  readonly appSg: ec2.SecurityGroup;
  readonly dataKey: kms.Key;
  readonly documents: s3.Bucket;
  readonly trailLogs: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;
  readonly database: rds.DatabaseInstance;
  readonly databaseUrl: string;

  constructor(scope: Construct, stage: string, cfg: StageConfig) {
    const prod = stage === 'prod';
    const keep = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.vpc = new ec2.Vpc(scope, 'Vpc', {
      maxAzs: 2,
      natGateways: prod ? 2 : 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const dbSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    this.appSg = new ec2.SecurityGroup(scope, 'AppSg', { vpc: this.vpc, description: 'CLAQ Lambda functions' });
    const dbSg = new ec2.SecurityGroup(scope, 'DbSg', { vpc: this.vpc, description: 'CLAQ PostgreSQL', allowAllOutbound: false });
    dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), 'Lambda to PostgreSQL');

    this.dataKey = new kms.Key(scope, 'DataKey', {
      enableKeyRotation: true,
      alias: `claq-${stage}-data`,
      removalPolicy: keep,
    });

    this.documents = new s3.Bucket(scope, 'Documents', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: !prod,
    });

    this.trailLogs = new s3.Bucket(scope, 'TrailLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: keep,
      autoDeleteObjects: !prod,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
    });

    this.dlq = new sqs.Queue(scope, 'NotificationsDlq', { encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
    this.queue = new sqs.Queue(scope, 'Notifications', { visibilityTimeout: Duration.seconds(70), encryption: sqs.QueueEncryption.SQS_MANAGED, deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 } });

    this.database = new rds.DatabaseInstance(scope, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, prod ? ec2.InstanceSize.LARGE : ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: dbSubnets,
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('claq_admin'),
      databaseName: 'claq',
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      multiAz: cfg.dbMultiAz,
      deletionProtection: cfg.deletionProtection,
      backupRetention: Duration.days(cfg.backupDays),
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      removalPolicy: keep,
    });

    // Secret values are resolved by CloudFormation at deploy time and never appear in the template.
    const secret = this.database.secret as import('aws-cdk-lib/aws-secretsmanager').ISecret;
    this.databaseUrl = `postgresql://claq_admin:{{resolve:secretsmanager:${secret.secretArn}:SecretString:password}}@${this.database.instanceEndpoint.hostname}:${this.database.instanceEndpoint.port}/claq?schema=public&sslmode=require&connection_limit=1`;
  }
}
