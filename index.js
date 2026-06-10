const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const app = express();
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Raw body:', data.substring(0, 500));
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch(e) {
      const params = new URLSearchParams(data);
      req.body = Object.fromEntries(params);
    }
    next();
  });
});

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  'http://localhost'
);

console.log('YouTube OAuth init:');
console.log('  Client ID:', process.env.YOUTUBE_CLIENT_ID ? 'SET' : 'MISSING');
console.log('  Client Secret:', process.env.YOUTUBE_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('  Refresh Token:', process.env.YOUTUBE_REFRESH_TOKEN ? process.env.YOUTUBE_REFRESH_TOKEN.substring(0,20)+'...' : 'MISSING');

oauth2Client.setCredentials({
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
});

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

async function uploadVideo(videoUrl, title, description, tags) {
  console.log(`Downloading video from: ${videoUrl}`);
  const response = await axios({ url: videoUrl, method: 'GET', responseType: 'stream' });

  console.log('Uploading to YouTube...');
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title,
        description: description,
        tags: tags ? tags.split(',').map(t => t.trim()) : [],
        categoryId: '28'
      },
      status: {
        privacyStatus: 'private'
      }
    },
    media: {
      mimeType: 'video/mp4',
      body: response.data
    }
  });

  const videoId = res.data.id;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

app.post('/upload', async (req, res) => {
  console.log('Body received:', JSON.stringify(req.body));
  let body = req.body;
  if (!body.video_url && req.rawBody) {
    const lines = req.rawBody.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      body = {
        video_url: lines[0],
        title: lines[1],
        callback_url: lines[2] || null
      };
      console.log('Parsed from lines:', JSON.stringify(body));
    }
  }
  const { video_url, title, description, tags, callback_url } = body;
  if (!video_url || !title) {
    return res.status(400).json({ error: 'Missing video_url or title', received: body });
  }
  res.json({ status: 'uploading', title });

  try {
    const youtubeUrl = await uploadVideo(video_url, title, description || '', tags || '');
    console.log(`Uploaded: ${youtubeUrl}`);
    if (callback_url) {
      await axios.post(callback_url, { youtube_url: youtubeUrl, title });
    }
  } catch (err) {
    const errMsg = err.message || 'Unknown error';
    const errCode = err.code || err.status || err.response?.status || 'unknown';
    console.error('Upload error:', errCode, errMsg);
    if (callback_url) {
      await axios.post(callback_url, { error: errMsg, title }).catch(() => {});
    }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

process.on('SIGTERM', () => {
  console.log('SIGTERM received — keeping alive for active uploads...');
  setTimeout(() => {
    console.log('Shutdown complete');
    process.exit(0);
  }, 300000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YouTube service on port ${PORT}`));
