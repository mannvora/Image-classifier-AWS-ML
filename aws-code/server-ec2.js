import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Readable } from 'stream';

const s3Client = new S3Client({ region: 'us-east-1' });
const sqsClient = new SQSClient({ region: 'us-east-1' });

const inputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-req-queue.fifo';
const outputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-resp-queue.fifo';
const inputBucket = '1231868809-in-bucket';
const outputBucket = '1231868809-out-bucket';

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
            console.log(s3Url);
            const outputFile = s3Url.split('/').pop();
            const fileKey = outputFile.replace(/^\d+_/, '');

            console.log(`Received image for processing: ${fileKey}`);

            const localFilePath = path.join('/tmp', fileKey);
            await downloadFromS3(inputBucket, fileKey, localFilePath);

            console.log("FilePath is ", localFilePath);

            const prediction = await runFaceRecognitionModel(localFilePath);

            const outputFileKey = `${fileKey}_result.txt`;
            await uploadToS3(outputBucket, outputFileKey, prediction);

            await sendMessageToOutputQueue(fileKey, prediction);

            await sqsClient.send(new DeleteMessageCommand({
                QueueUrl: inputQueueUrl,
                ReceiptHandle: data.Messages[0].ReceiptHandle
            }));

            console.log(`Processed image ${fileKey} and uploaded result to S3`);
        } else {
            console.log('No messages to process.');
        }
    } catch (error) {
        console.error('Error receiving message from input queue:', error);
    }

    setTimeout(pollInputQueue, 1000);
}

async function downloadFromS3(bucket, key, downloadPath) {
    const params = { Bucket: bucket, Key: key };
    const { Body } = await s3Client.send(new GetObjectCommand(params));
    const fileStream = fs.createWriteStream(downloadPath);

    return new Promise((resolve, reject) => {
        if (Body instanceof Readable) {
            Body.pipe(fileStream)
                .on('error', reject)
                .on('close', resolve);
        } else {
            reject(new Error('S3 object body is not a readable stream'));
        }
    });
}

async function runFaceRecognitionModel(imagePath) {
    return new Promise((resolve, reject) => {
        const command = `python3 /home/ubuntu/Image-classifier-AWS-ML/face_recognition.py ${imagePath}`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error running model: ${stderr}`);
                return reject(error);
            }
            console.log(`Model output: ${stdout}`);
            resolve(stdout.trim());
        });
    });
}

async function uploadToS3(bucket, key, data) {
    const params = {
        Bucket: bucket,
        Key: key,
        Body: data
    };
    return s3Client.send(new PutObjectCommand(params));
}

async function sendMessageToOutputQueue(fileKey, prediction) {
    const messageBody = JSON.stringify({
        outputKey: fileKey,
        prediction: prediction
    });

    const params = {
        QueueUrl: outputQueueUrl,
        MessageBody: messageBody
    };
    return sqsClient.send(new SendMessageCommand(params));
}

pollInputQueue();