import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

const app = express();
const port = 3000;

const s3Client = new S3Client({ region: 'us-east-1' });
const sqsClient = new SQSClient({ region: 'us-east-1' });

const inputBucket = '1231868809-in-bucket';
const outputBucket = '1231868809-out-bucket';
const inputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-req-queue.fifo';
const outputQueueUrl = 'https://sqs.us-east-1.amazonaws.com/767397723820/1231868809-resp-queue.fifo';

const upload = multer({ dest: 'uploads/' });

app.post('/', upload.single('inputFile'), async (req, res) => {
    console.log(req.file);
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    const filePath = path.join(__dirname, req.file.path);
    const fileContent = fs.readFileSync(filePath);
    const fileKey = `${req.file.originalname}`;

    console.log(fileKey);

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: inputBucket,
            Key: fileKey,
            Body: fileContent,
        }));

        const s3Url = `https://${inputBucket}.s3.amazonaws.com/${fileKey}`;

        const message = {
            QueueUrl: inputQueueUrl,
            MessageBody: JSON.stringify({ s3Url }),
            MessageGroupId: "Group1",
            MessageDeduplicationId: Date.now().toString(),
            MessageAttributes: {
            "Title": {
                DataType: "String",
                StringValue: "test message"
            }
            }
        };

        await sqsClient.send(new SendMessageCommand(message));

        const outputResult = await pollOutputQueue(fileKey);

        res.set('Content-Type', 'text/plain');
        res.send(`${fileKey}: ${outputResult}`);
    } catch (err) {
        console.error('Error processing file:', err);
        res.status(500).send('Server Error');
    } finally {
        fs.unlinkSync(filePath);
    }
});

async function pollOutputQueue(fileKey) {
    while (true) {
        const params = {
            QueueUrl: outputQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            MessageGroupId: "Group1",
            MessageDeduplicationId: Date.now().toString(),
            MessageAttributes: {
            "Title": {
                DataType: "String",
                StringValue: "test message"
            }
            }
        };

        const data = await sqsClient.send(new ReceiveMessageCommand(params));

        if (data.Messages && data.Messages.length > 0) {
            const message = JSON.parse(data.Messages[0].Body);
            const { outputKey, prediction } = message;

            if (outputKey === fileKey) {
                await sqsClient.send(new DeleteMessageCommand({
                    QueueUrl: outputQueueUrl,
                    ReceiptHandle: data.Messages[0].ReceiptHandle
                }));

                return prediction;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});