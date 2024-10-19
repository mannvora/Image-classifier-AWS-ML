import express from 'express';
import bodyParser from 'body-parser';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { exec } from 'child_process';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

const app = express();
const s3Client = new S3Client({ region: 'us-east-1' });

const inputBucket = '1231868809-in-bucket';
const outputBucket = '1231868809-out-bucket';

app.use(bodyParser.json());

app.post('/process-image', async (req, res) => {
    const { s3Url } = req.body;
    const fileKey = s3Url.split('/').pop();
    const localFilePath = path.join('/home/ec2-user/Image-classifier-AWS-ML/model/face_images_1000/', fileKey);

    try {
        // Download from S3
        await downloadFromS3(inputBucket, fileKey, localFilePath);
        console.log("FilePath is ", localFilePath);

        // Run the face recognition model
        const prediction = await runFaceRecognitionModel(localFilePath);
        console.log("Prediction is: ", prediction);

        // Upload result to S3
        const outputFileKey = `${fileKey}_result.txt`;
        await uploadToS3(outputBucket, outputFileKey, prediction);

        res.status(200).send({ message: `Processed image ${fileKey}`, result: prediction });
    } catch (error) {
        console.error('Error processing image:', error);
        res.status(500).send({ error: 'Error processing image' });
    }
});

async function downloadFromS3(bucket, key, downloadPath) {
    const params = { Bucket: bucket, Key: key };

    try {
        await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });

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
    } catch (error) {
        console.error('Error downloading file from S3:', error);
        throw error;
    }
}

async function runFaceRecognitionModel(imagePath) {
    return new Promise((resolve, reject) => {
        const command = `python3 /home/ec2-user/Image-classifier-AWS-ML/model/face_recognition.py ${imagePath}`;
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

const PORT = 3001; // Change the port as necessary
app.listen(PORT, () => {
    console.log(`App tier listening on port ${PORT}`);
});
