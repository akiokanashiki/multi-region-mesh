import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { EndpointType, HttpIntegration, RestApi, VpcLink } from "aws-cdk-lib/aws-apigateway";
import { AccessLog, DnsResponseType, GatewayRouteHostnameMatch, GatewayRouteSpec, HealthCheck, HttpRetryEvent, IMesh, IVirtualGateway, IVirtualService, Mesh, RouteSpec, ServiceDiscovery, TcpRetryEvent, VirtualGatewayListener, VirtualNodeListener, VirtualRouterListener, VirtualService, VirtualServiceProvider } from "aws-cdk-lib/aws-appmesh";
import { GatewayVpcEndpointAwsService, InterfaceVpcEndpointAwsService, Peer, Port, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { AppMeshProxyConfiguration, Cluster, ContainerDependencyCondition, ContainerImage, FargateService, FargateTaskDefinition, ICluster, LogDriver } from "aws-cdk-lib/aws-ecs";
import { INetworkLoadBalancer, NetworkLoadBalancer, NetworkTargetGroup, TargetType } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnRecordSet, CnameRecord, HostedZoneAttributes, IPrivateHostedZone, PrivateHostedZone } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export class RegionalStack extends Stack {
    constructor(scope: Construct, id: string, props: {
        accountId: string, region: string, vpcId: string,
        serviceNames: string[], serviceMeshZone: HostedZoneAttributes,
    }) {
        super(scope, id, {
            env: { account: props.accountId, region: props.region }
        });

        // prepare basic resources
        const vpc = Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        const cluster = new Cluster(this, 'Cluster', {
            vpc, defaultCloudMapNamespace: { name: `${props.region}.local` },
            // containerInsights: true,
        });
        const hostedZone = PrivateHostedZone.fromHostedZoneAttributes(this, 'ServiceMeshZone', props.serviceMeshZone)
        const mesh = new Mesh(this, 'Mesh');

        // setup endpoints for AWS services -- for workload
        vpc.addGatewayEndpoint('s3', { service: GatewayVpcEndpointAwsService.S3 });
        vpc.addInterfaceEndpoint('logs', { service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
        vpc.addInterfaceEndpoint('ecr', { service: InterfaceVpcEndpointAwsService.ECR });
        vpc.addInterfaceEndpoint('docker', { service: InterfaceVpcEndpointAwsService.ECR_DOCKER });
        vpc.addInterfaceEndpoint('mesh', { service: InterfaceVpcEndpointAwsService.APP_MESH });

        // setup endpoints for AWS services -- for vastion server
        vpc.addInterfaceEndpoint('ssm', { service: InterfaceVpcEndpointAwsService.SSM });
        vpc.addInterfaceEndpoint('ssmmsg', { service: InterfaceVpcEndpointAwsService.SSM_MESSAGES });
        vpc.addInterfaceEndpoint('ec2msg', { service: InterfaceVpcEndpointAwsService.EC2_MESSAGES });

        // deploy load balancer
        const loadBalancer = new NetworkLoadBalancer(this, 'NetworkLoadBalancer', {
            vpc, vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED }, internetFacing: false,
        });

        // deploy services
        const services = {} as { [seviceName: string]: IVirtualService };
        props.serviceNames.forEach((serviceName, i) => {
            const { service } = this.deployService({
                region: props.region, serviceName, hostedZone, cluster, mesh,
            });
            services[serviceName] = service;
        });

        // deploy gateway
        this.deployGateway({
            region: props.region, services, hostedZone, loadBalancer, listenerPort: 80, cluster, mesh,
        });

        // deploy api endpoints
        this.deployApiEndpoints({
            loadBalancer, serviceNames: props.serviceNames, serviceMeshZoneName: props.serviceMeshZone.zoneName,
        });
    }

    private deployApiEndpoints(args: {
        loadBalancer: INetworkLoadBalancer,
        serviceNames: string[],
        serviceMeshZoneName: string,
    }) {
        const scope = new Construct(this, 'ApiEndpoints');

        const vpcLink = new VpcLink(scope, 'VpcLink', { targets: [args.loadBalancer] });
        const apigw = new RestApi(scope, 'ApiGW', {
            endpointTypes: [EndpointType.REGIONAL],
        });
        args.serviceNames.forEach(serviceName => {
            apigw.root.addResource(serviceName).addProxy({
                anyMethod: true,
                defaultMethodOptions: {
                    requestParameters: { 'method.request.path.proxy': true },
                },
                defaultIntegration: new HttpIntegration(`http://${serviceName}.${args.serviceMeshZoneName}/{proxy}`, {
                    options: {
                        requestParameters: {
                            'integration.request.path.proxy': 'method.request.path.proxy'
                        },
                        vpcLink,
                    }
                }),
            });
        });
    }

    private deployGateway(args: {
        region: string,
        services: { [serviceName: string]: IVirtualService },
        hostedZone: IPrivateHostedZone,
        loadBalancer: INetworkLoadBalancer,
        listenerPort: number,
        cluster: ICluster,
        mesh: IMesh,
    }): {
        gateway: IVirtualGateway,
    } {
        const scope = new Construct(this, 'gateway');
        const containerPort = 9080;

        // define mesh
        const gateway = args.mesh.addVirtualGateway('gateawy', {
            listeners: [VirtualGatewayListener.http({ port: containerPort })],
            accessLog: AccessLog.fromFilePath('/dev/stdout'),
        });
        Object.keys(args.services).forEach(serviceName => {
            gateway.addGatewayRoute(serviceName, {
                routeSpec: GatewayRouteSpec.http({
                    routeTarget: args.services[serviceName],
                    match: { hostname: GatewayRouteHostnameMatch.exactly(`${serviceName}.${args.hostedZone.zoneName}`) }
                }),
            });
        });

        // deploy container
        const taskDefinition = new FargateTaskDefinition(scope, 'TaskDefinition');
        const repository = Repository.fromRepositoryArn(scope, 'EnvoyRepository', `arn:aws:ecr:${args.region}:840364872350:repository/aws-appmesh-envoy`);
        const envoy = taskDefinition.addContainer('envoy', {
            image: ContainerImage.fromEcrRepository(repository, 'v1.24.1.0-prod',),
            portMappings: [{ containerPort, }],
            healthCheck: {
                command: ['CMD-SHELL', 'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'],
                startPeriod: Duration.seconds(10),
                interval: Duration.seconds(5),
                timeout: Duration.seconds(2),
                retries: 3
            },
            environment: {
                APPMESH_RESOURCE_ARN: gateway.virtualGatewayArn,
            },
            essential: true,
            logging: LogDriver.awsLogs({
                streamPrefix: 'gateawy',
                logGroup: new LogGroup(scope, 'EnvoyLog', {
                    removalPolicy: RemovalPolicy.DESTROY,
                    retention: RetentionDays.ONE_DAY,
                })
            }),
        });
        gateway.grantStreamAggregatedResources(taskDefinition.taskRole);
        const taskSet = new FargateService(scope, 'TaskSet', { taskDefinition, cluster: args.cluster, });
        taskSet.connections.allowFrom(Peer.anyIpv4(), Port.tcp(containerPort));

        // connect tasks and load balancer
        const targetGroup = new NetworkTargetGroup(scope, 'TargetGroup', {
            vpc: args.cluster.vpc, port: containerPort,
            targetType: TargetType.IP, targets: [taskSet],
            deregistrationDelay: Duration.seconds(0),
        });
        args.loadBalancer.addListener('gatewayListener', {
            port: args.listenerPort,
            defaultTargetGroups: [targetGroup],
        });

        // expose
        return {
            gateway,
        };
    }

    private deployService(args: {
        region: string,
        serviceName: string,
        hostedZone: IPrivateHostedZone,
        cluster: ICluster,
        mesh: IMesh,
    }): {
        service: IVirtualService,
    } {
        const scope = new Construct(this, args.serviceName);
        const serviceDomain = `${args.serviceName}.${args.hostedZone.zoneName}`;
        const hostname = `${args.serviceName}.${args.cluster.defaultCloudMapNamespace!.namespaceName}`;
        const containerPort = 3000;

        // define mesh
        const node = args.mesh.addVirtualNode(`${args.serviceName}Node`, {
            serviceDiscovery: ServiceDiscovery.dns(serviceDomain, DnsResponseType.ENDPOINTS),
            listeners: [VirtualNodeListener.http({
                port: containerPort, healthCheck: HealthCheck.http({
                    path: '/health',
                    interval: Duration.seconds(5),
                    unhealthyThreshold: 2,
                    healthyThreshold: 3,
                    timeout: Duration.seconds(2),
                })
            })],
            accessLog: AccessLog.fromFilePath('/dev/stdout'),
        });
        const router = args.mesh.addVirtualRouter(`${args.serviceName}Router`, {
            listeners: [VirtualRouterListener.http(containerPort)],
        });
        router.addRoute('route', {
            routeSpec: RouteSpec.http({
                weightedTargets: [{ virtualNode: node }],
                timeout: { perRequest: Duration.seconds(30) },
                retryPolicy: {
                    tcpRetryEvents: [TcpRetryEvent.CONNECTION_ERROR],
                    httpRetryEvents: [HttpRetryEvent.STREAM_ERROR, HttpRetryEvent.GATEWAY_ERROR],
                    retryAttempts: 5,
                    retryTimeout: Duration.seconds(2),
                }
            })
        });
        const service = new VirtualService(scope, 'VirtualService', {
            virtualServiceName: serviceDomain,
            virtualServiceProvider: VirtualServiceProvider.virtualRouter(router),
        });

        // deploy container
        const taskDefinition = new FargateTaskDefinition(scope, 'TaskDefinition', {
            proxyConfiguration: new AppMeshProxyConfiguration({
                containerName: 'envoy',
                properties: {
                    proxyEgressPort: 15001,
                    proxyIngressPort: 15000,
                    egressIgnoredIPs: ['169.254.170.27', '169.254.169.254'],
                    egressIgnoredPorts: [22],
                    ignoredUID: 1337,
                    appPorts: [containerPort],
                }
            }),
        });
        const web = taskDefinition.addContainer('web', {
            image: ContainerImage.fromAsset(`${__dirname}/../service`),
            portMappings: [{ containerPort, }],
            environment: {
                SERVER_PORT: containerPort.toString(),
            },
            healthCheck: {
                command: ['CMD-SHELL', `curl -s http://localhost:${containerPort}/health | grep status | grep -q OK`],
                startPeriod: Duration.seconds(10),
                interval: Duration.seconds(5),
                timeout: Duration.seconds(2),
                retries: 3
            },
            essential: true,
            logging: LogDriver.awsLogs({
                streamPrefix: args.serviceName,
                logGroup: new LogGroup(scope, 'WebLog', {
                    removalPolicy: RemovalPolicy.DESTROY,
                    retention: RetentionDays.ONE_DAY,
                })
            }),
        });
        const repository = Repository.fromRepositoryArn(scope, 'EnvoyRepository', `arn:aws:ecr:${args.region}:840364872350:repository/aws-appmesh-envoy`);
        const envoy = taskDefinition.addContainer('envoy', {
            image: ContainerImage.fromEcrRepository(repository, 'v1.24.1.0-prod',),
            user: '1337',
            healthCheck: {
                command: ['CMD-SHELL', 'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'],
                startPeriod: Duration.seconds(10),
                interval: Duration.seconds(5),
                timeout: Duration.seconds(2),
                retries: 3
            },
            environment: {
                APPMESH_RESOURCE_ARN: node.virtualNodeArn,
            },
            essential: true,
            logging: LogDriver.awsLogs({
                streamPrefix: args.serviceName,
                logGroup: new LogGroup(scope, 'EnvoyLog', {
                    removalPolicy: RemovalPolicy.DESTROY,
                    retention: RetentionDays.ONE_DAY,
                })
            }),
        });
        web.addContainerDependencies({ container: envoy, condition: ContainerDependencyCondition.HEALTHY });
        node.grantStreamAggregatedResources(taskDefinition.taskRole);
        const taskSet = new FargateService(scope, 'TaskSet', {
            taskDefinition, cluster: args.cluster, cloudMapOptions: { name: args.serviceName }
        });
        taskSet.connections.allowFrom(Peer.anyIpv4(), Port.tcp(containerPort));

        // healthcheck
        /*
        const alarm = new Alarm(scope, 'Alarm', {
            metric: new Metric({
                namespace: 'ECS/InsightsContainerInsights',
                metricName: 'RunningTaskCount',
                dimensionsMap: {
                    ClusterName: args.cluster.clusterName,
                    ServiceName: taskSet.serviceName,
                }
            }).with({ period: Duration.minutes(1), statistic: Stats.AVERAGE, }),
            threshold: 1,
            comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });
        const healtcheck = new CfnHealthCheck(scope, 'HealthCheck', {
            healthCheckConfig: {
                type: 'CLOUDWATCH_METRIC',
                alarmIdentifier: {
                    region: args.region,
                    name: alarm.alarmName,
                },
                insufficientDataHealthStatus: 'LastKnownStatus',
            }
        });
        */

        // register dns records
        const record = new CnameRecord(scope, 'EndpointRecord', {
            zone: args.hostedZone, recordName: args.serviceName,
            domainName: hostname,
            ttl: Duration.minutes(1),
        });
        const cfnRS = record.node.defaultChild as CfnRecordSet;
        cfnRS.setIdentifier = args.region;
        cfnRS.region = args.region;
        // cfnRS.healthCheckId = healtcheck.ref;

        // expose
        return {
            service,
        };
    }
}