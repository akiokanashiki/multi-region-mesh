#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { HostedZoneAttributes } from 'aws-cdk-lib/aws-route53';
import 'source-map-support/register';
import { RegionalStack } from '../lib/RetionalStack';

const app = new App();
const accountId = process.env.CDK_DEFAULT_ACCOUNT as string;
const serviceNames = ['srv1', 'srv2'];
/*
const zoneId = 'Z06209813ROHET0ZVP3T9';
const zoneName = 'amenomahitotsu.net';
*/
const serviceMeshZone = { hostedZoneId: 'Z04733493P7CXLTCI8L45', zoneName: 'mesh.net' } as HostedZoneAttributes;

new RegionalStack(app, 'HndStack', {
  accountId, region: 'ap-northeast-1', vpcId: 'vpc-07bcfd02df2db2a36',
  serviceNames, serviceMeshZone,
});
new RegionalStack(app, 'KixStack', {
  accountId, region: 'ap-northeast-3', vpcId: 'vpc-0080767fc5c8031cd',
  serviceNames, serviceMeshZone,
});