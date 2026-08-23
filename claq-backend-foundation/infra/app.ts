#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ClaqStack } from './stack.js';
const app = new cdk.App();
const env = app.node.tryGetContext('env') ?? 'demo';
new ClaqStack(app, `claq-${env}`, { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }, stage: env });
