// CF-tgfile (modified)
// Changes:
// - Removed Bing wallpaper usage; static blank UI backgrounds
// - Removed 20MB upload restriction (no size limit checks here)
// - Admin: added view toggle (Grid cards / List details) with Share/Download/Delete
// - DOMAIN env no longer required; domain inferred from request URL (origin)
// - Keeps Telegram-backed storage, QR sharing, search, caching
//
// NOTE: Telegram direct file URLs may expire and size limits are governed by Telegram, not this app.

// Database init
async function initDatabase(config) {
  await config.database.prepare(`
    CREATE TABLE IF NOT EXISTS files (
      url TEXT PRIMARY KEY,
      fileId TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT
    )
  `).run();
}

// Exported Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Config (derive domain from current request; no DOMAIN/MAX_SIZE needed)
    const config = {
      origin: url.origin, // e.g., https://example.com
      database: env.DATABASE,
      username: env.USERNAME,
      password: env.PASSWORD,
      enableAuth: env.ENABLE_AUTH === 'true',
      tgBotToken: env.TG_BOT_TOKEN,
      tgChatId: env.TG_CHAT_ID,
      cookie: Number(env.COOKIE) || 7
    };

    await initDatabase(config);

    const routes = {
      '/': () => handleAuthRequest(request, config),
      '/login': () => handleLoginRequest(request, config),
      '/upload': () => handleUploadRequest(request, config),
      '/admin': () => handleAdminRequest(request, config),
      '/delete': () => handleDeleteRequest(request, config),
      '/search': () => handleSearchRequest(request, config)
    };

    const handler = routes[url.pathname];
    if (handler) return await handler();
    return await handleFileRequest(request, config);
  }
};

// -------- Auth helpers --------
function authenticate(request, config) {
  const cookies = request.headers.get("Cookie") || "";
  const authToken = cookies.match(/auth_token=([^;]+)/);
  if (!authToken) return false;
  try {
    const tokenData = JSON.parse(atob(authToken[1]));
    const now = Date.now();
    if (now > tokenData.expiration) return false;
    return tokenData.username === config.username;
  } catch {
    return false;
  }
}

async function handleAuthRequest(request, config) {
  if (config.enableAuth) {
    if (!authenticate(request, config)) return handleLoginRequest(request, config);
    return handleUploadRequest(request, config);
  }
  return handleUploadRequest(request, config);
}

async function handleLoginRequest(request, config) {
  if (request.method === 'POST') {
    const { username, password } = await request.json();
    if (username === config.username && password === config.password) {
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + config.cookie);
      const token = btoa(JSON.stringify({ username: config.username, expiration: expirationDate.getTime() }));
      const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; Expires=${expirationDate.toUTCString()}`;
      return new Response("OK", { status: 200, headers: { "Set-Cookie": cookie, "Content-Type": "text/plain" } });
    }
    return new Response("Unauthorized", { status: 401 });
  }
  const html = generateLoginPage();
  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

// -------- Upload --------
async function handleUploadRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }

  if (request.method === 'GET') {
    const html = generateUploadPage();
    return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) throw new Error('未找到文件');

    // Guess Telegram method by MIME family
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mimeType = getContentType(ext);
    const [mainType] = mimeType.split('/');
    const typeMap = {
      image: { method: 'sendPhoto', field: 'photo' },
      video: { method: 'sendVideo', field: 'video' },
      audio: { method: 'sendAudio', field: 'audio' }
    };
    let { method = 'sendDocument', field = 'document' } = typeMap[mainType] || {};
    if (['application', 'text'].includes(mainType)) { method = 'sendDocument'; field = 'document'; }

    const tgFormData = new FormData();
    tgFormData.append('chat_id', config.tgChatId);
    tgFormData.append(field, file, file.name);

    const tgResponse = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/${method}`, { method: 'POST', body: tgFormData });
    if (!tgResponse.ok) throw new Error('Telegram参数配置错误');

    const tgData = await tgResponse.json();
    const result = tgData.result;
    const messageId = result?.message_id;
    const fileId = result?.document?.file_id || result?.video?.file_id || result?.audio?.file_id || (result?.photo && result.photo[result.photo.length-1]?.file_id);
    if (!fileId) throw new Error('未获取到文件ID');
    if (!messageId) throw new Error('未获取到tg消息ID');

    const time = Date.now();
    const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const url = `${config.origin}/${time}.${ext}`;

    await config.database.prepare(`
      INSERT INTO files (url, fileId, message_id, created_at, file_name, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      url, fileId, messageId, timestamp, file.name, file.size, file.type || getContentType(ext)
    ).run();

    return new Response(JSON.stringify({ status: 1, msg: "✔ 上传成功", url }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    let statusCode = 500;
    if (error.message.includes('Telegram参数配置错误')) statusCode = 502;
    else if (error instanceof TypeError && error.message.includes('Failed to fetch')) statusCode = 504;
    return new Response(JSON.stringify({ status: 0, msg: "✘ 上传失败", error: error.message }), { status: statusCode, headers: { "Content-Type": "application/json" } });
  }
}

// -------- Admin (list + grid) --------
async function handleAdminRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }

  const files = await config.database.prepare(
    `SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
     FROM files
     ORDER BY created_at DESC`
  ).all();

  const fileList = files.results || [];

  const fileCards = fileList.map(file => {
    const fileName = file.file_name;
    const fileSize = formatSize(file.file_size || 0);
    const createdAt = new Date(file.created_at).toISOString().replace('T', ' ').split('.')[0];
    return `
      <div class="file-card" data-url="${file.url}">
        <div class="file-preview">${getPreviewHtml(file.url)}</div>
        <div class="file-info">
          <div class="name">${escapeHtml(fileName)}</div>
          <div class="size">${fileSize}</div>
          <div class="time">${createdAt}</div>
        </div>
        <div class="file-actions">
          <button class="btn btn-copy" onclick="showQRCode('${file.url}')">分享</button>
          <a class="btn btn-down" href="${file.url}" download="${escapeHtml(fileName)}">下载</a>
          <button class="btn btn-delete" onclick="deleteFile('${file.url}')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  const fileRows = fileList.map((file, idx) => {
    const fileName = file.file_name;
    const fileSize = formatSize(file.file_size || 0);
    const createdAt = new Date(file.created_at).toISOString().replace('T', ' ').split('.')[0];
    return `
      <tr data-url="${file.url}">
        <td class="idx">${idx + 1}</td>
        <td class="name">${escapeHtml(fileName)}</td>
        <td class="size">${fileSize}</td>
        <td class="type">${escapeHtml(file.mime_type || '')}</td>
        <td class="time">${createdAt}</td>
        <td class="actions">
          <button class="btn btn-copy" onclick="showQRCode('${file.url}')">分享</button>
          <a class="btn btn-down" href="${file.url}" download="${escapeHtml(fileName)}">下载</a>
          <button class="btn btn-delete" onclick="deleteFile('${file.url}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  const qrModal = `
    <div id="qrModal" class="qr-modal">
      <div class="qr-content">
        <div id="qrcode"></div>
        <div class="qr-buttons">
          <button class="qr-copy" onclick="handleCopyUrl()">复制链接</button>
          <button class="qr-close" onclick="closeQRModal()">关闭</button>
        </div>
      </div>
    </div>
  `;

  const html = generateAdminPage(fileCards, fileRows, qrModal);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

// -------- Search API --------
async function handleSearchRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { query } = await request.json();
    const searchPattern = `%${query}%`;
    const files = await config.database.prepare(
      `SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
       FROM files
       WHERE file_name LIKE ? ESCAPE '!'
       COLLATE NOCASE
       ORDER BY created_at DESC`
    ).bind(searchPattern).all();
    return new Response(JSON.stringify({ files: files.results || [] }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// -------- File fetch & cache --------
async function handleFileRequest(request, config) {
  const url = request.url;
  const cache = caches.default;
  const cacheKey = new Request(url);
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const file = await config.database.prepare(
      `SELECT fileId, message_id, file_name, mime_type
       FROM files WHERE url = ?`
    ).bind(url).first();
    if (!file) return new Response('文件不存在', { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });

    const tgResp = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${file.fileId}`);
    if (!tgResp.ok) return new Response('获取文件失败', { status: 500, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
    const tgData = await tgResp.json();
    const filePath = tgData.result?.file_path;
    if (!filePath) return new Response('文件路径无效', { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });

    const fileUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${filePath}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) return new Response('下载文件失败', { status: 500, headers: { "Content-Type": "text/plain; charset=UTF-8" } });

    const contentType = file.mime_type || getContentType(url.split('.').pop().toLowerCase());
    const response = new Response(fileResponse.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.file_name || '')}`
      }
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    return new Response('服务器内部错误', { status: 500, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
}

// -------- Delete --------
async function handleDeleteRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { url } = await request.json();
    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: '无效的URL' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const file = await config.database.prepare('SELECT fileId, message_id FROM files WHERE url = ?').bind(url).first();
    if (!file) return new Response(JSON.stringify({ error: '文件不存在' }), { status: 404, headers: { "Content-Type": "application/json" } });

    let deleteError = null;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgChatId}&message_id=${file.message_id}`);
      if (!resp.ok) {
        const errorData = await resp.json();
        throw new Error(`Telegram 消息删除失败: ${errorData.description}`);
      }
    } catch (e) { deleteError = e.message; }

    await config.database.prepare('DELETE FROM files WHERE url = ?').bind(url).run();
    return new Response(JSON.stringify({ success: true, message: deleteError ? `文件已从数据库删除，但Telegram消息删除失败: ${deleteError}` : '文件删除成功' }), { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message.includes('message to delete not found') ? '文件已从频道移除' : error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// -------- Utils --------
function getPreviewHtml(url) {
  const ext = (url.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'icon'].includes(ext);
  const isVideo = ['mp4', 'webm'].includes(ext);
  const isAudio = ['mp3', 'wav', 'ogg'].includes(ext);
  if (isImage) return `<img src="${url}" alt="预览">`;
  if (isVideo) return `<video src="${url}" controls></video>`;
  if (isAudio) return `<audio src="${url}" controls></audio>`;
  return `<div style="font-size: 48px">📄</div>`;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex++; }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function getContentType(ext) {
  const types = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', icon: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    zip: 'application/zip', rar: 'application/x-rar-compressed',
    json: 'application/json', xml: 'application/xml', ini: 'text/plain',
    js: 'application/javascript', yml: 'application/yaml', yaml: 'application/yaml',
    py: 'text/x-python', sh: 'application/x-sh'
  };
  return types[ext] || 'application/octet-stream';
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, s => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[s]));
}

// -------- Pages --------
function generateLoginPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录</title>
    <style>
      body { display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f5f5f5; font-family:Arial, sans-serif; }
      .login-container { background:#fff; padding:20px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.08); width:100%; max-width:400px; }
      .form-group { margin-bottom:1rem; }
      input { width:100%; padding:0.75rem; border:1px solid #ddd; border-radius:4px; font-size:1rem; box-sizing:border-box; }
      button { width:100%; padding:0.75rem; background:#007bff; color:#fff; border:none; border-radius:4px; font-size:1rem; cursor:pointer; margin-bottom:10px; }
      button:hover { background:#0056b3; }
      .error { color:#dc3545; margin-top:1rem; display:none; }
    </style>
  </head>
  <body>
    <div class="login-container">
      <h2 style="text-align:center; margin-bottom:2rem;">登录</h2>
      <form id="loginForm">
        <div class="form-group"><input type="text" id="username" placeholder="用户名" required></div>
        <div class="form-group"><input type="password" id="password" placeholder="密码" required></div>
        <button type="submit">登录</button>
        <div id="error" class="error">用户名或密码错误</div>
      </form>
    </div>
    <script>
      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        try {
          const response = await fetch('/', { method:'POST', headers:{ 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
          if (response.ok) window.location.href = '/upload'; else document.getElementById('error').style.display = 'block';
        } catch { document.getElementById('error').style.display = 'block'; }
      });
    </script>
  </body>
  </html>`;
}

function generateUploadPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件上传</title>
    <style>
      body { font-family:Arial, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; background:#f5f5f5; margin:0; }
      .container { max-width:800px; width:100%; background:#fff; padding:10px 40px 20px 40px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.08); overflow-y:auto; max-height:90vh; }
      .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
      .upload-area { border:2px dashed #666; padding:40px; text-align:center; margin:0 auto; border-radius:8px; transition:all 0.3s; box-sizing:border-box; }
      .upload-area.dragover { border-color:#007bff; background:#f8f9fa; }
      .preview-area { margin-top:20px; }
      .preview-item { display:flex; align-items:center; padding:10px; border:1px solid #ddd; margin-bottom:10px; border-radius:4px; }
      .preview-item img { max-width:100px; max-height:100px; margin-right:10px; }
      .preview-item .info { flex-grow:1; }
      .url-area { margin-top:10px; width:calc(100% - 20px); box-sizing:border-box; }
      .url-area textarea { width:100%; min-height:100px; padding:10px; border:1px solid #ddd; border-radius:4px; background:#fafafa; color:#333; }
      .admin-link { display:inline-block; margin-left:auto; color:#007bff; text-decoration:none; }
      .admin-link:hover { text-decoration:underline; }
      .button-group { margin-top:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; }
      .button-container button { margin-right:10px; padding:5px 10px; border:none; border-radius:4px; background:#007bff; color:#fff; cursor:pointer; }
      .button-container button:hover { background:#0056b3; }
      .copyright { margin-left:auto; font-size:12px; color:#888; }
      .progress-bar { height:20px; background:#eee; border-radius:10px; margin:8px 0; overflow:hidden; position:relative; }
      .progress-track { height:100%; background:#007bff; transition:width 0.3s ease; width:0; }
      .progress-text { position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); color:white; font-size:12px; }
      .success .progress-track { background:#28a745; }
      .error .progress-track { background:#dc3545; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>文件上传</h1>
        <a href="/admin" class="admin-link">进入管理页面</a>
      </div>
      <div class="upload-area" id="uploadArea">
        <p>点击选择 或 拖拽文件到此处</p>
        <input type="file" id="fileInput" multiple style="display:none">
      </div>
      <div class="preview-area" id="previewArea"></div>
      <div class="url-area">
        <textarea id="urlArea" readonly placeholder="上传完成后的链接将显示在这里"></textarea>
        <div class="button-group">
          <div class="button-container">
            <button onclick="copyUrls('url')">复制URL</button>
            <button onclick="copyUrls('markdown')">复制Markdown</button>
            <button onclick="copyUrls('html')">复制HTML</button>
          </div>
          <div class="copyright">
            <span>© 2025</span>
          </div>
        </div>
      </div>
    </div>
    <script>
      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const previewArea = document.getElementById('previewArea');
      const urlArea = document.getElementById('urlArea');
      let uploadedUrls = [];

      ['dragenter','dragover','dragleave','drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
      });
      function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
      ['dragenter','dragover'].forEach(eName => uploadArea.addEventListener(eName, () => uploadArea.classList.add('dragover'), false));
      ['dragleave','drop'].forEach(eName => uploadArea.addEventListener(eName, () => uploadArea.classList.remove('dragover'), false));

      uploadArea.addEventListener('drop', handleDrop, false);
      uploadArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFiles);
      document.addEventListener('paste', async (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) { if (item.kind === 'file') { const file = item.getAsFile(); await uploadFile(file); } }
      });

      function handleDrop(e) { const dt = e.dataTransfer; const files = dt.files; handleFiles({ target: { files } }); }
      async function handleFiles(e) {
        const files = Array.from(e.target.files);
        for (let file of files) { await uploadFile(file); }
      }

      async function uploadFile(file) {
        const preview = createPreview(file);
        previewArea.appendChild(preview);

        const xhr = new XMLHttpRequest();
        const progressTrack = preview.querySelector('.progress-track');
        const progressText = preview.querySelector('.progress-text');
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressTrack.style.width = percent + '%';
            progressText.textContent = percent + '%';
          }
        });
        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            const progressText = preview.querySelector('.progress-text');
            if (xhr.status >= 200 && xhr.status < 300 && data.status === 1) {
              progressText.textContent = data.msg;
              uploadedUrls.push(data.url);
              updateUrlArea();
              preview.classList.add('success');
            } else {
              const errorMsg = [data.msg, data.error || '未知错误'].filter(Boolean).join(' | ');
              progressText.textContent = errorMsg;
              preview.classList.add('error');
            }
          } catch {
            preview.querySelector('.progress-text').textContent = '✗ 响应解析失败';
            preview.classList.add('error');
          }
        });
        const formData = new FormData(); formData.append('file', file);
        xhr.open('POST', '/upload'); xhr.send(formData);
      }

      function createPreview(file) {
        const div = document.createElement('div');
        div.className = 'preview-item';
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img'); img.src = URL.createObjectURL(file); div.appendChild(img);
        }
        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = \`
          <div>\${file.name}</div>
          <div>\${formatSize(file.size)}</div>
          <div class="progress-bar">
            <div class="progress-track"></div>
            <span class="progress-text">0%</span>
          </div>\`;
        div.appendChild(info); return div;
      }
      function formatSize(bytes){ const u=['B','KB','MB','GB']; let s=bytes,i=0; while(s>=1024&&i<u.length-1){s/=1024;i++;} return s.toFixed(2)+' '+u[i]; }
      function updateUrlArea(){ urlArea.value = uploadedUrls.join('\\n'); }
      function copyUrls(fmt){ let text=''; if(fmt==='url') text = uploadedUrls.join('\\n'); else if(fmt==='markdown') text = uploadedUrls.map(u=>\`![](\${u})\`).join('\\n'); else text = uploadedUrls.map(u=>\`<img src="\${u}" />\`).join('\\n'); navigator.clipboard.writeText(text); alert('已复制到剪贴板'); }
    </script>
  </body>
  </html>`;
}

function generateAdminPage(fileCards, fileRows, qrModal) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件管理</title>
    <style>
      body { font-family:Arial, sans-serif; margin:0; padding:20px; background:#f5f5f5; }
      .container { max-width:1200px; margin:0 auto; }
      .header { background:#fff; padding:20px 30px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.08); margin-bottom:20px; display:flex; align-items:center; gap:20px; }
      h2 { margin:0; }
      .right-content { display:flex; gap:16px; margin-left:auto; align-items:center; }
      .search { padding:8px; border:1px solid #ddd; border-radius:4px; width:280px; background:#fafafa; }
      .view-toggle { display:flex; gap:8px; }
      .toggle-btn { padding:8px 12px; border:1px solid #ddd; background:#fff; border-radius:6px; cursor:pointer; }
      .toggle-btn.active { border-color:#007bff; color:#007bff; }
      .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:20px; }
      .file-card { background:#fff; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.08); overflow:hidden; position:relative; }
      .file-preview { height:150px; background:#fafafa; display:flex; align-items:center; justify-content:center; }
      .file-preview img, .file-preview video { max-width:100%; max-height:100%; object-fit:contain; }
      .file-info { padding:10px; font-size:14px; }
      .file-info .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .file-actions { padding:10px; border-top:1px solid #eee; display:flex; gap:8px; justify-content:flex-end; font-size:12px; }
      .btn { padding:5px 10px; border:none; border-radius:4px; cursor:pointer; }
      .btn-delete { background:#dc3545; color:#fff; }
      .btn-copy, .btn-down { background:#007bff; color:#fff; text-decoration:none; }
      .list { display:none; background:#fff; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.08); }
      table { width:100%; border-collapse:collapse; }
      th, td { border-bottom:1px solid #eee; padding:10px 12px; text-align:left; }
      th { background:#fafafa; }
      .actions .btn { margin-right:6px; }
      .qr-modal { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); justify-content:center; align-items:center; z-index:1000; }
      .qr-content { background:#fff; padding:20px; border-radius:10px; text-align:center; box-shadow:0 2px 10px rgba(0,0,0,0.2); }
      #qrcode { margin:5px 0; }
      .qr-buttons { display:flex; gap:10px; justify-content:center; margin-top:15px; }
      .qr-copy, .qr-close { padding:8px 20px; background:#007bff; color:#fff; border:none; border-radius:5px; cursor:pointer; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>文件管理</h2>
        <div class="view-toggle">
          <button id="btnGrid" class="toggle-btn active">卡片</button>
          <button id="btnList" class="toggle-btn">列表</button>
        </div>
        <div class="right-content">
          <a href="/upload" class="toggle-btn">返回</a>
          <input type="text" class="search" placeholder="搜索文件..." id="searchInput">
        </div>
      </div>

      <div class="grid" id="gridView">${fileCards}</div>

      <div class="list" id="listView">
        <table>
          <thead><tr><th>#</th><th>文件名</th><th>大小</th><th>类型</th><th>时间</th><th>操作</th></tr></thead>
          <tbody id="listBody">${fileRows}</tbody>
        </table>
      </div>

      ${qrModal}
    </div>

    <script src="https://cdn.jsdelivr.net/npm/qrcodejs/qrcode.min.js"></script>
    <script>
      // Search (works for both views)
      const searchInput = document.getElementById('searchInput');
      const gridView = document.getElementById('gridView');
      const listView = document.getElementById('listView');
      const listBody = document.getElementById('listBody');
      const gridCards = Array.from(gridView.children);
      const listRows = Array.from(listBody.querySelectorAll('tr'));

      searchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        gridCards.forEach(card => {
          const name = card.querySelector('.file-info .name').textContent.toLowerCase();
          card.style.display = name.includes(q) ? '' : 'none';
        });
        listRows.forEach(row => {
          const name = row.querySelector('.name').textContent.toLowerCase();
          row.style.display = name.includes(q) ? '' : 'none';
        });
      });

      // View toggle
      const btnGrid = document.getElementById('btnGrid');
      const btnList = document.getElementById('btnList');
      function setView(mode){
        if(mode==='grid'){ gridView.style.display='grid'; listView.style.display='none'; btnGrid.classList.add('active'); btnList.classList.remove('active'); }
        else { gridView.style.display='none'; listView.style.display='block'; btnGrid.classList.remove('active'); btnList.classList.add('active'); }
      }
      btnGrid.addEventListener('click', () => setView('grid'));
      btnList.addEventListener('click', () => setView('list'));

      // QR share helpers
      let currentShareUrl = '';
      function showQRCode(url) {
        currentShareUrl = url;
        const modal = document.getElementById('qrModal');
        const qrcodeDiv = document.getElementById('qrcode');
        const copyBtn = document.querySelector('.qr-copy');
        copyBtn.textContent = '复制链接';
        copyBtn.disabled = false;
        qrcodeDiv.innerHTML = '';
        new QRCode(qrcodeDiv, { text: url, width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.H });
        modal.style.display = 'flex';
      }
      function handleCopyUrl() {
        navigator.clipboard.writeText(currentShareUrl).then(() => {
          const copyBtn = document.querySelector('.qr-copy');
          copyBtn.textContent = '✔ 已复制'; copyBtn.disabled = true;
          setTimeout(() => { copyBtn.textContent = '复制链接'; copyBtn.disabled = false; }, 3000);
        }).catch(() => alert('复制失败，请手动复制'));
      }
      function closeQRModal(){ document.getElementById('qrModal').style.display = 'none'; }
      window.onclick = function(e){ const modal = document.getElementById('qrModal'); if (e.target === modal) modal.style.display='none'; }

      // Delete (works for both views)
      async function deleteFile(url) {
        if (!confirm('确定要删除这个文件吗？')) return;
        try {
          const res = await fetch('/delete', { method:'POST', headers:{ 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
          if (!res.ok) { const err = await res.json(); throw new Error(err.error || '删除失败'); }
          const gridCard = document.querySelector(\`.file-card[data-url="\${url}"]\`);
          const listRow = document.querySelector(\`tr[data-url="\${url}"]\`);
          if (gridCard) gridCard.remove();
          if (listRow) listRow.remove();
          alert('文件删除成功');
        } catch (e) { alert('文件删除失败: ' + e.message); }
      }

      // Expose functions to global
      window.showQRCode = showQRCode;
      window.handleCopyUrl = handleCopyUrl;
      window.closeQRModal = closeQRModal;
      window.deleteFile = deleteFile;

      // Default view
      setView('grid');
    </script>
  </body>
  </html>`;
}
