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
  const { video_url, title, description, tags, callback_url } = req.body;
  if (!video_url || !title) {
    return res.status(400).json({ error: 'Missing video_url or title' });
  }
  res.json({ status: 'uploading', title });

  try {
    const youtubeUrl = await uploadVideo(video_url, title, description || '', tags || '');
    console.log(`Uploaded: ${youtubeUrl}`);
    if (callback_url) {
      await axios.post(callback_url, { youtube_url: youtubeUrl, title });
    }
  } catch (err) {
    const detail = err.errors || err.response?.data?.error?.errors || err.response?.data || err.message;
    console.error('Upload error full:', JSON.stringify(detail, null, 2));
    console.error('Upload error code:', err.code || err.status || err.response?.status);
    if (callback_url) {
      await axios.post(callback_url, { error: JSON.stringify(detail), title }).catch(() => {});
    }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YouTube service on port ${PORT}`));
