    import express from 'express';
    import fs from 'fs';
    import path from 'path';
    import multer from 'multer';
    import AWS from 'aws-sdk';

    AWS.config.update({ region: 'us-east-1' }); // Change to your AWS region

    const app = express();
    const port = 3000;

    const s3 = new AWS.S3();
    const sqs = new AWS.SQS();

    // Configure the S3 bucket names
    const inputBucket = 'your-input-bucket';  // Input S3 bucket name
    const outputBucket = 'your-output-bucket'; // Output S3 bucket name

    // Configure SQS queue URLs
    const inputQueueUrl = 'https://sqs.<region>.amazonaws.com/<account_id>/input-queue';  // Input SQS queue URL
    const outputQueueUrl = 'https://sqs.<region>.amazonaws.com/<account_id>/output-queue'; // Output SQS queue URL

    // Multer to handle file uploads
    const upload = multer({ dest: 'uploads/' });

    // Route to handle image uploads
    app.post('/', upload.single('inputFile'), async (req, res) => {
        if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    try {
        // Step 1: Upload the file to S3 Input Bucket
        const filePath = path.join(__dirname, req.file.path);
        const fileContent = fs.readFileSync(filePath);
        const fileKey = `${Date.now()}_${req.file.originalname}`;

        await s3.putObject({
        Bucket: inputBucket,
        Key: fileKey,
        Body: fileContent,
        }).promise();

        // Step 2: Send S3 URL to Input SQS Queue
        const s3Url = `https://${inputBucket}.s3.amazonaws.com/${fileKey}`;
        const message = {
        QueueUrl: inputQueueUrl,
        MessageBody: JSON.stringify({ s3Url })
        };
        await sqs.sendMessage(message).promise();

        // Step 3: Poll Output SQS Queue for processed result
        const outputResult = await pollOutputQueue(fileKey);

        // Step 4: Send processed result back to the client
        res.set('Content-Type', 'text/plain');
        res.send(`${fileKey}: ${outputResult}`);

    } catch (err) {
        console.error('Error processing file:', err);
        res.status(500).send('Server Error');
    } finally {
        // Clean up: Remove the locally saved file
        fs.unlinkSync(filePath);
    }
    });

    // Function to poll Output SQS Queue for result
    async function pollOutputQueue(fileKey) {
    while (true) {
        const params = {
        QueueUrl: outputQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10
        };

        const data = await sqs.receiveMessage(params).promise();

        if (data.Messages && data.Messages.length > 0) {
        const message = JSON.parse(data.Messages[0].Body);
        const { outputKey, prediction } = message;

        if (outputKey === fileKey) {
            // Delete the message from the queue after processing
            await sqs.deleteMessage({
            QueueUrl: outputQueueUrl,
            ReceiptHandle: data.Messages[0].ReceiptHandle
            }).promise();

            // Return the processed result
            return prediction;
        }
        }

        // Wait a few seconds before checking again
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    }

    // Start the server
    app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    });
