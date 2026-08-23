import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
export class ClaqStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { stage: string }) { super(scope,id,props);
    const prod = props.stage === 'prod';
    const documents = new s3.Bucket(this,'Documents',{ blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL, encryption:s3.BucketEncryption.S3_MANAGED, versioned:true, enforceSSL:true, removalPolicy: prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY, autoDeleteObjects:!prod });
    const dlq = new sqs.Queue(this,'NotificationsDlq',{ encryption:sqs.QueueEncryption.SQS_MANAGED, retentionPeriod:cdk.Duration.days(14) });
    const queue = new sqs.Queue(this,'Notifications',{ encryption:sqs.QueueEncryption.SQS_MANAGED, deadLetterQueue:{queue:dlq,maxReceiveCount:3} });
    const pool = new cognito.UserPool(this,'Users',{ selfSignUpEnabled:false, signInAliases:{email:true}, mfa:cognito.Mfa.OPTIONAL, mfaSecondFactor:{otp:true,sms:false}, passwordPolicy:{minLength:12,requireDigits:true,requireLowercase:true,requireUppercase:true,requireSymbols:true} });
    const apiFn = new nodejs.NodejsFunction(this,'Api',{ entry:'src/api.ts', handler:'handler', runtime:lambda.Runtime.NODEJS_22_X, environment:{APP_ENV:props.stage,DOCUMENT_BUCKET:documents.bucketName,NOTIFICATION_QUEUE:queue.queueUrl}, timeout:cdk.Duration.seconds(28), tracing:lambda.Tracing.ACTIVE, logRetention:prod?logs.RetentionDays.ONE_YEAR:logs.RetentionDays.ONE_MONTH });
    documents.grantReadWrite(apiFn); queue.grantSendMessages(apiFn);
    const api = new apigwv2.HttpApi(this,'Api',{ createDefaultStage:true });
    api.addRoutes({path:'/v1/{proxy+}',methods:[apigwv2.HttpMethod.ANY],integration:new integrations.HttpLambdaIntegration('Integration',apiFn)});
    new cdk.CfnOutput(this,'ApiUrl',{value:api.apiEndpoint}); new cdk.CfnOutput(this,'UserPoolId',{value:pool.userPoolId}); new cdk.CfnOutput(this,'DocumentBucket',{value:documents.bucketName});
    cdk.Tags.of(this).add('System','CLAQ'); cdk.Tags.of(this).add('Environment',props.stage);
  }
}
