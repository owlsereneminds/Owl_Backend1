import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import startRoute from './routes/start.js';
import userRoute from './routes/user.js';
import metadataRoute from './routes/metadata.js';
import uploadRoute from './routes/upload.js';
import finalizeRoute from './routes/finalize.js';
import uploadChunkRoute from './routes/upload-chunk.js';
import finalizeUploadRoute from './routes/finalize-upload.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.get("/", (req, res) => {
    res.send("Welcome to the backend");
  });
app.use('/api/start', startRoute);  
app.use('/api/user', userRoute);
app.use('/api/metadata', metadataRoute);
app.use('/api/upload', uploadRoute);
app.use('/api/finalize', finalizeRoute);
app.use('/api/upload-chunks', uploadChunkRoute);
app.use('/api/finalize-upload', finalizeUploadRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
