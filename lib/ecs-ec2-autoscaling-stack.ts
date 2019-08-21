import * as cdk from '@aws-cdk/core';
import { Vpc, InstanceType } from '@aws-cdk/aws-ec2';
import { AutoScalingGroup, AdjustmentType } from '@aws-cdk/aws-autoscaling';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as elb from '@aws-cdk/aws-elasticloadbalancingv2';
import * as ecs from '@aws-cdk/aws-ecs';


export class EcsEc2AutoscalingStack extends cdk.Stack {
  readonly STACK_NAME = 'ecs-ec2-autoscaling';

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'vpc', {
      cidr: '10.0.0.0/16',
    });

    const lb = new elb.ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('listener', {
      port: 80,
      open: true,
    });
    listener.addTargetGroups('black-hole-target', {
      targetGroups: [ 
        new elb.ApplicationTargetGroup(this, 'black-hole-target', {
          vpc: vpc,
          protocol: elb.ApplicationProtocol.HTTP,
          port: 80,
        })
      ]
    });

    const cluster = new ecs.Cluster(this, 'cluster', {
      clusterName: this.STACK_NAME,
      vpc,
    });

    const asg = new AutoScalingGroup(this, 'asg', {
      vpc,
      instanceType: new InstanceType('t2.large'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux(),
      minCapacity: 3,
      maxCapacity: 10,
      cooldown: cdk.Duration.seconds(60),
    });

    // asg.scaleOnCpuUtilization('cpu-instance-scaling', { 
    //   targetUtilizationPercent: 60,
    // })

    /*    
      Scaling        -1          (no change)          +1       +3
                  │        │                       │        │        │
                  ├────────┼───────────────────────┼────────┼────────┤
                  │        │                       │        │        │
      Reservation 0%      10%                     50%       70%     100%
    */
   const workerUtilizationMetric = new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUReservation',
        dimensions: { ClusterName: this.STACK_NAME },
        period: cdk.Duration.minutes(1)
    });
    asg.scaleOnMetric('cpu-reservation-scaling', {
      metric: workerUtilizationMetric,
      scalingSteps: [
        { upper: 10, change: -1 },
        { lower: 50, change: +1 },
        { lower: 70, change: +3 },
      ],
      // Change this to AdjustmentType.PERCENT_CHANGE_IN_CAPACITY to interpret the
      // 'change' numbers before as percentages instead of capacity counts.
      adjustmentType: AdjustmentType.CHANGE_IN_CAPACITY,
    });

    
    cluster.addAutoScalingGroup(asg);

    const tg1 = listener.addTargets('web-service-1', { 
      priority: 1,
      hostHeader: 'web-1.com',
      port: 80 ,
      healthCheck: { path: '/api/v2/health' },
    });
    const service1 = this.createService(cluster, tg1, 'service-1')
    tg1.addTarget(service1)

    const tg2 = listener.addTargets('web-service-2', { 
      priority: 2,
      hostHeader: 'web-2.com',
      port: 80 ,
      healthCheck: { path: '/api/v2/health' },
    });
    const service2 = this.createService(cluster, tg2, 'service-2')
    tg2.addTarget(service2)
  }

  private createService(cluster: ecs.ICluster, tg: elb.ApplicationTargetGroup, id: string): ecs.BaseService {
    const taskDefinition = new ecs.Ec2TaskDefinition(this, `${id}-task-definition`);

    const container = taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('legdba/servicebox-nodejs'),
      memoryLimitMiB: 256,
      cpu: 128,
      logging: new ecs.AwsLogDriver({ streamPrefix: `${this.STACK_NAME}-${id}` }),
    });
    container.addPortMappings({
      containerPort: 8080,
    });
  
    const service = new ecs.Ec2Service(this, id, {
      serviceName: `${this.STACK_NAME}-${id}`,
      cluster,
      taskDefinition,
    });
    
    const scaling = service.autoScaleTaskCount({ 
      minCapacity: 2,
      maxCapacity: 10,
    });
    scaling.scaleOnCpuUtilization(`${id}-cpu-task-scaling`, {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(30),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });
    scaling.scaleOnRequestCount(`${id}-request-task-scaling`, {
      targetGroup: tg,
      requestsPerTarget: 20,
    });

    return service;
  }
}
