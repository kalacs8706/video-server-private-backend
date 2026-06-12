const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static'); // 1. Import the static binary path
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 2. Point fluent-ffmpeg to the static binary location
ffmpeg.setFfmpegPath(ffmpegPath); 

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir() });

// In-memory global store to hold the state of running jobs
const jobs = {};

// --- ENDPOINT 1: VIDEO TO ZIP ---
app.post('/process-video', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).send('No video file uploaded.');

    const jobId = Date.now().toString();
    const fps = parseInt(req.body.fps) || 10;
    const videoPath = req.file.path;
    const outputFolder = path.join(os.tmpdir(), `frames_${jobId}`);
    const zipPath = path.join(os.tmpdir(), `pack_${jobId}.zip`);

    fs.mkdirSync(outputFolder, { recursive: true });

    jobs[jobId] = { status: 'processing', stage: 'Slicing frames', progress: 0, fileToDelete: zipPath, originalName: req.file.originalname };
    res.json({ jobId }); // Hand back the tracking ticket instantly

    ffmpeg(videoPath)
        .fps(fps)
        .output(path.join(outputFolder, 'frame-%05d.png'))
        .output(path.join(outputFolder, 'audio.wav'))
        .on('progress', (progress) => {
            if (jobs[jobId]) jobs[jobId].progress = Math.min(95, Math.round(progress.percent || 0));
        })
        .on('end', async () => {
            if (!jobs[jobId]) return;
            jobs[jobId].stage = 'Creating ZIP archive';
            
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 5 } });
            
            output.on('close', () => {
                if (jobs[jobId]) {
                    jobs[jobId].status = 'completed';
                    jobs[jobId].progress = 100;
                }
                cleanupDir(videoPath, outputFolder);
            });

            archive.pipe(output);
            archive.directory(outputFolder, false);
            archive.finalize();
        })
        .on('error', (err) => {
            console.error(err);
            if (jobs[jobId]) jobs[jobId].status = 'failed';
            cleanupDir(videoPath, outputFolder);
        })
        .run();
});

// --- ENDPOINT 2: ZIP TO VIDEO ---
app.post('/process-zip', upload.single('zip'), (req, res) => {
    if (!req.file) return res.status(400).send('No zip file uploaded.');

    const jobId = Date.now().toString();
    const fps = parseInt(req.body.fps) || 10;
    const zipPath = req.file.path;
    const extractFolder = path.join(os.tmpdir(), `unzip_${jobId}`);
    const videoOutputPath = path.join(os.tmpdir(), `rebuilt_${jobId}.mp4`);

    jobs[jobId] = { status: 'processing', stage: 'Extracting assets', progress: 10, fileToDelete: videoOutputPath, originalName: req.file.originalname };
    res.json({ jobId });

    try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractFolder, true);
        fs.unlinkSync(zipPath); // Delete raw uploaded zip early

        const files = fs.readdirSync(extractFolder);
        const totalFrames = files.filter(f => f.endsWith('.png')).length;

        if (totalFrames === 0) {
            jobs[jobId].status = 'failed';
            return cleanupDir(null, extractFolder);
        }

        jobs[jobId].stage = 'Compiling video track';

        let command = ffmpeg()
            .input(path.join(extractFolder, 'frame-%05d.png'))
            .inputOptions([`-framerate ${fps}`]);

        // Check if an audio file exists in the package
        if (fs.existsSync(path.join(extractFolder, 'audio.wav'))) {
            command.input(path.join(extractFolder, 'audio.wav'));
        }

        command.output(videoOutputPath)
            .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart'])
            .on('progress', (progress) => {
                if (jobs[jobId]) {
                    const pct = Math.round((progress.frames / totalFrames) * 100);
                    jobs[jobId].progress = Math.min(99, pct || 0);
                }
            })
            .on('end', () => {
                if (jobs[jobId]) {
                    jobs[jobId].status = 'completed';
                    jobs[jobId].progress = 100;
                }
                cleanupDir(null, extractFolder);
            })
            .on('error', (err) => {
                console.error(err);
                if (jobs[jobId]) jobs[jobId].status = 'failed';
                cleanupDir(null, extractFolder);
                if (fs.existsSync(videoOutputPath)) fs.unlinkSync(videoOutputPath);
            })
            .run();

    } catch (err) {
        console.error(err);
        jobs[jobId].status = 'failed';
        cleanupDir(null, extractFolder);
    }
});

// --- ENDPOINT 3: STATUS POLLING ---
app.get('/job/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).send('Job not found.');
    res.json(job);
});

// --- ENDPOINT 4: STREAM DOWNLOAD ---
app.get('/download/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job || job.status !== 'completed') return res.status(400).send('File not ready.');

    const targetName = job.originalName.split('.')[0];
    const isZip = job.fileToDelete.endsWith('.zip');
    const attachmentName = isZip ? `${targetName}_assets.zip` : `${targetName}_rebuilt.mp4`;

    res.download(job.fileToDelete, attachmentName, () => {
        // Immediate clean up from disk space after transaction drops
        if (fs.existsSync(job.fileToDelete)) fs.unlinkSync(job.fileToDelete);
        delete jobs[req.params.id];
    });
});

function cleanupDir(file, folder) {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    if (folder && fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Job Engine active on port ${PORT}`));
