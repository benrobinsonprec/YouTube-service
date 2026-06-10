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

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    console.log('Using cached access token');
    return accessToken;
  }
  console.log('Refreshing access token...');
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    });
    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + ((res.data.expires_in - 60) * 1000);
    console.log('Access token refreshed, expires in', res.data.expires_in, 'seconds');
    return accessToken;
  } catch (err) {
    console.error('Token refresh failed:', err.response?.status, err.response?.data?.error, err.response?.data?.error_description);
    throw err;
  }
}

console.log('YouTube OAuth init:');
console.log('  Client ID:', process.env.YOUTUBE_CLIENT_ID ? 'SET' : 'MISSING');
console.log('  Client Secret:', process.env.YOUTUBE_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('  Refresh Token:', process.env.YOUTUBE_REFRESH_TOKEN ? process.env.YOUTUBE_REFRESH_TOKEN.substring(0,20)+'...' : 'MISSING');

async function uploadVideo(videoUrl, title, description, tags) {
  console.log(`Downloading video from: ${videoUrl}`);
  const videoResponse = await axios({ url: videoUrl, method: 'GET', responseType: 'arraybuffer' });

  const token = await getAccessToken();
  console.log('Uploading to YouTube...');

  const metadata = {
    snippet: {
      title: title,
      description: description,
      tags: tags ? tags.split(',').map(t => t.trim()) : [],
      categoryId: '28'
    },
    status: {
      privacyStatus: 'private'
    }
  };

  // Initiate resumable upload
  console.log('Initiating resumable upload...');
  try {
    const initRes = await axios.post('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable',
      metadata,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const uploadUrl = initRes.headers.location;
    console.log('Resumable session created, upload URL:', uploadUrl.substring(0, 80));

    // Upload video file
    console.log('Uploading video file...');
    const uploadRes = await axios.put(uploadUrl,
      videoResponse.data,
      {
        headers: {
          'Content-Type': 'video/mp4'
        }
      }
    );

    const videoId = uploadRes.data.id;
    console.log('Upload complete, video ID:', videoId);
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch (err) {
    console.error('Upload step failed:', err.response?.status, err.response?.data || err.message);
    throw err;
  }
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
