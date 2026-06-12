const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors()); // Allows your frontend website to talk to this server

// Configure multer to store uploaded videos in the system's temporary directory
const upload = multer({ dest: os.tmpdir() });

app.post('/process', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No video file uploaded.');
    }

    const fps = req.body.fps || 10;
    const videoPath = req.file.path;
    const uniqueId = Date.now().toString();
    const outputFolder = path.join(os.tmpdir(), `frames_${uniqueId}`);
    const zipPath = path.join(os.tmpdir(), `pack_${uniqueId}.zip`);

    fs.mkdirSync(outputFolder, { recursive: true });

    try {
        // 1. Run FFmpeg to extract frames and audio into the temp folder
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .fps(fps)
                .output(path.join(outputFolder, 'frame-%05d.png'))
                .output(path.join(outputFolder, 'audio.wav'))
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // 2. Zip everything inside that output folder
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });

        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(outputFolder, false);
            archive.finalize();
        });

        // 3. Send the ZIP file back directly to the user's browser
        res.download(zipPath, 'extracted_video_assets.zip', () => {
            // Cleanup files after download completes to keep the server clean
            cleanup(videoPath, outputFolder, zipPath);
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('Error processing video.');
        cleanup(videoPath, outputFolder, zipPath);
    }
});

function cleanup(video, folder, zip) {
    if (fs.existsSync(video)) fs.unlinkSync(video);
    if (fs.existsSync(zip)) fs.unlinkSync(zip);
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));