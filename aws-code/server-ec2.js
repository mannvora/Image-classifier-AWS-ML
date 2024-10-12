    import AWS from 'aws-sdk';
    import fs from 'fs';
    import path from 'path';
    import { exec } from 'child_process';

    AWS.config.update({ region: 'us-east-1' });
    const s3 = new AWS.S3();
    const sqs = new AWS.SQS();

    const inputQueueUrl = 'https://sqs.<region>.amazonaws.com/<account_id>/input-queue';
    const outputQueueUrl = 'https://sqs.<region>.amazonaws.com/<account_id>/output-queue';
    const inputBucket = 'your-input-bucket';
    const outputBucket = 'your-output-bucket';

    async function pollInputQueue() {
    const params = {
        QueueUrl: inputQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10
    };

    try {
        const data = await sqs.receiveMessage(params).promise();
        if (data.Messages && data.Messages.length > 0) {
        const message = JSON.parse(data.Messages[0].Body);
        const s3Url = message.s3Url;
        const fileKey = s3Url.split('/').pop();

        console.log(`Received image for processing: ${fileKey}`);

        const localFilePath = path.join('/tmp', fileKey);
        await downloadFromS3(inputBucket, fileKey, localFilePath);

        const prediction = await runFaceRecognitionModel(localFilePath);

        const outputFileKey = `${fileKey}_result.txt`;
        await uploadToS3(outputBucket, outputFileKey, prediction);

        await sendMessageToOutputQueue(fileKey, prediction);
        
        await sqs.deleteMessage({
            QueueUrl: inputQueueUrl,
            ReceiptHandle: data.Messages[0].ReceiptHandle
        }).promise();

        console.log(`Processed image ${fileKey} and uploaded result to S3`);

        } else {
        console.log('No messages to process.');
        }
    } catch (error) {
        console.error('Error receiving message from input queue:', error);
    }

    setTimeout(pollInputQueue, 5000);
    }

    async function downloadFromS3(bucket, key, downloadPath) {
    const params = { Bucket: bucket, Key: key };
    const fileStream = fs.createWriteStream(downloadPath);
    const s3Stream = s3.getObject(params).createReadStream();

    return new Promise((resolve, reject) => {
        s3Stream.pipe(fileStream)
        .on('error', reject)
        .on('close', resolve);
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
    return s3.putObject(params).promise();
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
    return sqs.sendMessage(params).promise();
    }

    pollInputQueue();
