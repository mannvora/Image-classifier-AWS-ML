import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { EC2Client, RunInstancesCommand, DescribeInstancesCommand, TerminateInstancesCommand, AllocateAddressCommand, AssociateAddressCommand, ReleaseAddressCommand } from '@aws-sdk/client-ec2';
import axios from 'axios';

const s3Client = new S3Client({ region: 'us-east-1' });
const sqsClient = new SQSClient({ region: 'us-east-1' });
const ec2Client = new EC2Client({ region: 'us-east-1' });

const inputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-req-queue.fifo';
const outputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-resp-queue.fifo';
const instanceType = 't2.micro';
const amiId = 'ami-06b21ccaeff8cd686';
const maxInstances = 20;
let instanceIds = [];
let elasticIps = []; // Array to hold Elastic IPs

async function pollInputQueue() {
    const params = {
        QueueUrl: inputQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10
    };

    try {
        const data = await sqsClient.send(new ReceiveMessageCommand(params));
        if (data.Messages && data.Messages.length > 0) {
            const message = JSON.parse(data.Messages[0].Body);
            const s3Url = message.s3Url;

            console.log(`Received image for processing: ${s3Url}`);

            // Check and scale instances if needed
            await manageInstances(data.Messages.length);

            setTimeout(() => {}, 10000);

            // Send request to the appropriate instance
            await distributeRequestsToInstances([message]);

            await sqsClient.send(new DeleteMessageCommand({
                QueueUrl: inputQueueUrl,
                ReceiptHandle: data.Messages[0].ReceiptHandle
            }));
        } else {
            console.log('No messages to process.');
        }
    } catch (error) {
        console.error('Error receiving message from input queue:', error);
    }

    setTimeout(pollInputQueue, 1000);
}

async function manageInstances(totalMessages) {
    const currentCount = instanceIds.length;

    // Check the number of messages in the queue
    let messageCount = totalMessages;

    console.log(messageCount, instanceIds.length);

    if (messageCount > currentCount && currentCount < maxInstances) {
        const instancesToLaunch = Math.min(maxInstances - currentCount, messageCount - currentCount);
        console.log("Making new instnaces");
        await launchInstances(instancesToLaunch);
    } else if (currentCount > 0 && currentCount > messageCount) {
        const instancesToTerminate = currentCount - messageCount;
        await terminateInstances(instanceIds.slice(-instancesToTerminate)); // Terminate excess instances
    }
}

async function getQueueMessageCount() {
    const params = {
        QueueUrl: inputQueueUrl,
    };

    const { Attributes } = await sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: inputQueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
    return parseInt(Attributes.ApproximateNumberOfMessages, 10);
}

async function waitForInstancesToBeRunning(instanceIds) {
    let running = false;
    while (!running) {
        const params = {
            InstanceIds: instanceIds,
        };

        const data = await ec2Client.send(new DescribeInstancesCommand(params));
        const allRunning = data.Reservations.every(reservation => 
            reservation.Instances.every(instance => instance.State.Name === 'running')
        );

        if (allRunning) {
            running = true;
        } else {
            console.log('Waiting for instances to be running...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before checking again
        }
    }
    console.log('All instances are now running.');
}

async function launchInstances(count) {
    const userDataScript = `
        #!/bin/bash
        sudo yum update -y > /var/log/user_data_script.log 2>&1
        sudo yum install -y git nodejs python3-pip >> /var/log/user_data_script.log 2>&1 || { echo "Package installation failed!" >> /var/log/user_data_script.log; exit 1; }
        
        cd /home/ec2-user >> /var/log/user_data_script.log 2>&1
        git clone https://github.com/mannvora/Image-classifier-AWS-ML.git >> /var/log/user_data_script.log 2>&1
        
        cd /home/ec2-user/Image-classifier-AWS-ML >> /var/log/user_data_script.log 2>&1
        pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu >> /var/log/user_data_script.log 2>&1 || { echo "pip install failed!" >> /var/log/user_data_script.log; exit 1; }
        
        cd /home/ec2-user/Image-classifier-AWS-ML/aws-code >> /var/log/user_data_script.log 2>&1
        npm install >> /var/log/user_data_script.log 2>&1 || { echo "npm install failed!" >> /var/log/user_data_script.log; exit 1; }
        
        node poller-webTier.js >> /var/log/user_data_script.log 2>&1 || { echo "Failed to run poller-webTier.js" >> /var/log/user_data_script.log; exit 1; }    
    `;

    const params = {
        ImageId: amiId,
        InstanceType: instanceType,
        MinCount: count,
        MaxCount: count,
        KeyName: 'cse546-key', 
        SecurityGroupIds: ['sg-0a376fe6adfd4cd1e'],
        UserData: Buffer.from(userDataScript).toString('base64'), // Base64 encode the user data script
        TagSpecifications: [
            {
                ResourceType: 'instance',
                Tags: [
                    {
                        Key: 'Name',
                        Value: `app-tier-instance-${instanceIds.length + 1}`
                    }
                ]
            }
        ]
    };

    // Launch the instances
    const data = await ec2Client.send(new RunInstancesCommand(params));

    // Wait for each instance to be in the 'running' state
    const newInstances = data.Instances.map(instance => instance.InstanceId);
    if (newInstances.length === 0) {
        console.error('No instances were launched.');
        return;
    }

    await waitForInstancesToBeRunning(newInstances);

    // Allocate and associate Elastic IPs
    for (const instanceId of newInstances) {
        instanceIds.push(instanceId);
        const elasticIp = await allocateAndAssociateElasticIp(instanceId);
        elasticIps.push(elasticIp);
    }

    console.log(`Launched ${count} instances:`, instanceIds);
    console.log(`Associated Elastic IPs:`, elasticIps);
}


async function terminateInstances(instanceIdsToTerminate) {
    // Terminate instances and release their Elastic IPs
    for (const instanceId of instanceIdsToTerminate) {
        const elasticIp = elasticIps.shift(); // Remove the first IP from the array
        if (elasticIp) {
            await releaseElasticIp(elasticIp); // Release the Elastic IP
        }
    }

    const params = {
        InstanceIds: instanceIdsToTerminate,
    };

    await ec2Client.send(new TerminateInstancesCommand(params));
    instanceIds = instanceIds.filter(id => !instanceIdsToTerminate.includes(id)); // Update instanceIds array
    console.log(`Terminated instances: ${instanceIdsToTerminate}`);
}

async function allocateAndAssociateElasticIp(instanceId) {
    const { AllocationId } = await ec2Client.send(new AllocateAddressCommand({ Domain: 'vpc' }));
    await ec2Client.send(new AssociateAddressCommand({
        InstanceId: instanceId,
        AllocationId: AllocationId,
    }));
    return AllocationId; // Return the Elastic IP Allocation ID
}

async function releaseElasticIp(allocationId) {
    await ec2Client.send(new ReleaseAddressCommand({ AllocationId: allocationId }));
    console.log(`Released Elastic IP: ${allocationId}`);
}

async function distributeRequestsToInstances(requests) {
    for (let i = 0; i < requests.length; i++) {
        const request = requests[i];
        const instanceId = instanceIds[i % instanceIds.length];

        // Send request to the instance's HTTP endpoint
        await sendRequestToInstance(instanceId, request);
    }
}

async function sendRequestToInstance(instanceId, request) {
    const publicIp = await getInstancePublicIp(instanceId);
    
    if (!publicIp) {
        console.error(`Skipping request. No public IP for instance: ${instanceId}`);
        return;
    }

   // http://${publicIp}:3000/process-image

    const payload = { s3Url: request.s3Url };
    const appTierUrl = `http://${publicIp}:3000/process-image`; // Adjust port if needed

    try {
        const response = await axios.post(appTierUrl, payload);
        console.log(`Response from instance ${instanceId}:`, response.data);
    } catch (error) {
        console.error(`Error sending request to instance ${instanceId}:`, error.message);
    }
}

async function getInstancePublicIp(instanceId) {
    const params = {
        InstanceIds: [instanceId],
    };

    const data = await ec2Client.send(new DescribeInstancesCommand(params));

    if (!data.Reservations[0] || !data.Reservations[0].Instances[0].PublicIpAddress) {
        console.error(`Could not retrieve public IP for instance: ${instanceId}`);
        return null;
    }

    return data.Reservations[0].Instances[0].PublicIpAddress;
}

async function startProcessing() {
    console.log('Starting custom scaling and message processing...');
    pollInputQueue();
}

startProcessing();
