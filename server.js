const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir() });
const jobs = {};

// --- HELPER: ASSET SCANNER ---
// Recursively finds all images and audio files no matter what folders they are hidden in
function findAssets(dir, pngs = [], audios = []) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
            findAssets(fullPath, pngs, audios);
        } else {
            const lower = fullPath.toLowerCase();
            if (lower.endsWith('.png')) pngs.push(fullPath);
            if (lower.match(/\.(wav|mp3)$/)) audios.push(fullPath);
        }
    }
    return { pngs, audios };
}

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
    res.json({ jobId });

    ffmpeg(videoPath)
        .fps(fps)
        .output(path.join(outputFolder, 'img-%05d.png'))
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
            console.error("FFmpeg Extract Error:", err);
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
        fs.unlinkSync(zipPath);

        jobs[jobId].stage = 'Normalizing file structures';

        // Find all scattered assets and bring them to the root
        const { pngs, audios } = findAssets(extractFolder);
        
        // Sort alphabetically to maintain original frame sequence
        pngs.sort();

        if (pngs.length === 0) {
            console.error("No PNG frames found inside the uploaded ZIP.");
            jobs[jobId].status = 'failed';
            return cleanupDir(null, extractFolder);
        }

        // Rename all images to a strict sequential format (seq-00001.png, seq-00002.png...)
        pngs.forEach((oldPath, index) => {
            const newPath = path.join(extractFolder, `seq-${String(index + 1).padStart(5, '0')}.png`);
            fs.renameSync(oldPath, newPath);
        });

        // Handle Audio
        let targetAudioPath = null;
        if (audios.length > 0) {
            targetAudioPath = path.join(extractFolder, 'main_audio.wav');
            fs.renameSync(audios[0], targetAudioPath);
        }

        jobs[jobId].stage = 'Compiling video track';

        let command = ffmpeg()
            .input(path.join(extractFolder, 'seq-%05d.png'))
            .inputOptions([`-framerate ${fps}`]);

        if (targetAudioPath) {
            command.input(targetAudioPath);
        }

        command.output(videoOutputPath)
            .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart'])
            .on('progress', (progress) => {
                if (jobs[jobId]) {
                    const pct = Math.round((progress.frames / pngs.length) * 100);
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
                console.error("FFmpeg Compile Error:", err);
                if (jobs[jobId]) jobs[jobId].status = 'failed';
                cleanupDir(null, extractFolder);
                if (fs.existsSync(videoOutputPath)) fs.unlinkSync(videoOutputPath);
            })
            .run();

    } catch (err) {
        console.error("Extraction/Normalization Error:", err);
        if (jobs[jobId]) jobs[jobId].status = 'failed';
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
