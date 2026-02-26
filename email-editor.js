#!/usr/bin/env node
// email-editor.js -- AI Blog Assistant via email
// Real conversational AI: Claude Sonnet IS the assistant
// Polls support@nichtagentur.at, responds naturally to any email

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const net = require('net');
const { execSync } = require('child_process');

// Import blog functions from generate.js
const blog = require('./generate.js');

// --------------- Config ---------------

const IMAP_HOST = 'mail.easyname.eu';
const IMAP_PORT = 993;
const IMAP_USER = 'support@nichtagentur.at';
const IMAP_PASS = process.env.IMAP_PASS || process.env.SMTP_PASS || 'i_am_an_AI_password_2026';

// Send FROM support@ (authenticate as support@ too)
const SMTP_HOST = blog.SMTP_HOST;
const SMTP_USER = 'support@nichtagentur.at';
const SMTP_PASS = IMAP_PASS;
const SMTP_FROM = 'support@nichtagentur.at';

const ALLOWED_SENDERS = [
  'franz.enzenhofer@fullstackoptimization.com',
  'support@nichtagentur.at', // self-test
];

const POLL_INTERVAL = 30000;
const ANTHROPIC_KEY = blog.ANTHROPIC_KEY;
const HISTORY_FILE = path.join(__dirname, 'email-history.json');
const BLOG_URL = blog.BASE_URL;

// --------------- Conversation History ---------------

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(history) {
  // Keep last 10 exchanges
  const trimmed = history.slice(-10);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

function addToHistory(entry) {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

// --------------- IMAP Client (raw TLS) ---------------

function imapConnect() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IMAP connect timeout')), 15000);
    const sock = tls.connect(IMAP_PORT, IMAP_HOST, { servername: IMAP_HOST }, () => {
      clearTimeout(timeout);
      resolve(sock);
    });
    sock.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function imapCommand(sock, tag, cmd) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`IMAP timeout: ${cmd}`)), 15000);
    let buffer = '';
    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(tag + ' ')) {
          sock.removeListener('data', onData);
          clearTimeout(timeout);
          resolve(buffer);
          return;
        }
      }
    }
    sock.on('data', onData);
    sock.write(tag + ' ' + cmd + '\r\n');
  });
}

function imapGreeting(sock) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IMAP greeting timeout')), 10000);
    function onData(chunk) {
      const line = chunk.toString();
      if (line.startsWith('* OK')) {
        sock.removeListener('data', onData);
        clearTimeout(timeout);
        resolve(line);
      }
    }
    sock.on('data', onData);
  });
}

async function checkFolder(sock, tag, folderName) {
  const emails = [];
  let t = tag();
  let res = await imapCommand(sock, t, `SELECT ${folderName}`);
  if (res.includes(t + ' NO')) return emails;

  t = tag();
  res = await imapCommand(sock, t, 'SEARCH UNSEEN');
  const searchLine = res.split('\r\n').find(l => l.startsWith('* SEARCH'));
  if (!searchLine || searchLine.trim() === '* SEARCH') return emails;

  const seqNums = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);

  for (const seqNum of seqNums) {
    t = tag();
    res = await imapCommand(sock, t, `FETCH ${seqNum} (BODY[HEADER.FIELDS (FROM SUBJECT DATE TO CONTENT-TRANSFER-ENCODING CONTENT-TYPE)] BODY[TEXT])`);
    const email = parseImapFetch(res, seqNum);
    email._folder = folderName;

    if (!isAllowedSender(email.from)) {
      console.log(`  Ignored email from: ${email.from} (${folderName})`);
      t = tag();
      await imapCommand(sock, t, `STORE ${seqNum} +FLAGS (\\Seen)`);
      continue;
    }

    // Skip our own replies (prevent reply loops)
    const senderEmail = extractEmail(email.from);
    if (senderEmail === SMTP_FROM && email.subject.startsWith('Re:')) {
      console.log(`  Skipped own reply: ${email.subject} (${folderName})`);
      t = tag();
      await imapCommand(sock, t, `STORE ${seqNum} +FLAGS (\\Seen)`);
      continue;
    }

    t = tag();
    await imapCommand(sock, t, `STORE ${seqNum} +FLAGS (\\Seen)`);
    emails.push(email);
  }
  return emails;
}

async function checkInbox() {
  let sock;
  try {
    sock = await imapConnect();
    await imapGreeting(sock);
    let tagNum = 1;
    const tag = () => 'A' + String(tagNum++).padStart(3, '0');

    let t = tag();
    let res = await imapCommand(sock, t, `LOGIN ${IMAP_USER} ${IMAP_PASS}`);
    if (res.includes(t + ' NO') || res.includes(t + ' BAD')) {
      throw new Error(`IMAP login failed for ${IMAP_USER}`);
    }

    const emails = [];
    emails.push(...await checkFolder(sock, tag, 'INBOX'));
    emails.push(...await checkFolder(sock, tag, 'Junk'));

    t = tag();
    sock.write(t + ' LOGOUT\r\n');
    sock.end();
    return emails;
  } catch (err) {
    if (sock) { try { sock.end(); } catch {} }
    throw err;
  }
}

// --------------- Email Parsing ---------------

function parseImapFetch(raw, seqNum) {
  const result = { seqNum, from: '', subject: '', body: '', to: '', date: '' };

  const headerMatch = raw.match(/HEADER\.FIELDS[^\r\n]*\}\r\n([\s\S]*?)\r\n\r\n/);
  if (headerMatch) {
    const headers = headerMatch[1];
    const fromMatch = headers.match(/^From:\s*(.+)/mi);
    const subjectMatch = headers.match(/^Subject:\s*(.+)/mi);
    const toMatch = headers.match(/^To:\s*(.+)/mi);
    const dateMatch = headers.match(/^Date:\s*(.+)/mi);
    if (fromMatch) result.from = fromMatch[1].trim();
    if (subjectMatch) result.subject = decodeHeader(subjectMatch[1].trim());
    if (toMatch) result.to = toMatch[1].trim();
    if (dateMatch) result.date = dateMatch[1].trim();
  }

  const bodyMatch = raw.match(/BODY\[TEXT\]\s*\{(\d+)\}\r\n([\s\S]*)/);
  if (bodyMatch) {
    let body = bodyMatch[2];
    const literalLen = parseInt(bodyMatch[1]);
    if (literalLen > 0 && body.length > literalLen) {
      body = body.substring(0, literalLen);
    }

    const cteMatch = raw.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = cteMatch ? cteMatch[1].toLowerCase() : '7bit';

    if (encoding === 'quoted-printable') {
      body = decodeQuotedPrintable(body);
    } else if (encoding === 'base64') {
      body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    }

    const ctMatch = raw.match(/Content-Type:\s*multipart\/\w+;\s*boundary="?([^"\s;]+)"?/i);
    if (ctMatch) {
      body = extractTextPlain(bodyMatch[2], ctMatch[1]);
    }

    result.body = body.trim();
  }
  return result;
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeHeader(str) {
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, data) => {
    if (encoding.toUpperCase() === 'B') {
      return Buffer.from(data, 'base64').toString('utf8');
    } else {
      return decodeQuotedPrintable(data.replace(/_/g, ' '));
    }
  });
}

function extractTextPlain(body, boundary) {
  const parts = body.split('--' + boundary);
  for (const part of parts) {
    if (part.match(/Content-Type:\s*text\/plain/i)) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx !== -1) {
        let text = part.substring(idx + 4);
        const cte = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        if (cte && cte[1].toLowerCase() === 'quoted-printable') {
          text = decodeQuotedPrintable(text);
        } else if (cte && cte[1].toLowerCase() === 'base64') {
          text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8');
        }
        return text.trim();
      }
    }
  }
  return body.replace(/--[\s\S]*?Content-Type:[\s\S]*?\r\n\r\n/g, '').trim();
}

// --------------- Security ---------------

function extractEmail(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader.trim()).toLowerCase();
}

function isAllowedSender(fromHeader) {
  const email = extractEmail(fromHeader);
  if (!email) return false;
  return ALLOWED_SENDERS.some(s => s.toLowerCase() === email);
}

// --------------- The AI Assistant (Claude Sonnet) ---------------

async function askAssistant(email) {
  const articles = blog.loadArticles();
  const articleList = articles.length > 0
    ? articles.map(a => `- "${a.title}" (slug: ${a.slug}, date: ${a.date})`).join('\n')
    : '(no articles yet)';

  const history = loadHistory();
  const recentHistory = history.slice(-5).map(h =>
    `[${h.date}] From: ${h.from}\nSubject: ${h.subject}\nBody: ${h.body}\nAssistant reply: ${h.reply}\nActions: ${JSON.stringify(h.actions)}`
  ).join('\n---\n');

  const systemPrompt = `You are the AI editor for Franz Enzenhofer's blog "Franz AI Blog".
Franz (or a tester) emails you and you respond like a smart, helpful colleague.

You can:
- Have natural conversations, discuss ideas, answer questions
- Write new blog articles on any topic asked about
- Edit/rework existing articles based on feedback
- List articles, give status updates
- Brainstorm article ideas
- Anything else a smart editorial assistant would do

Current blog state:
- URL: ${BLOG_URL}
- Total articles: ${articles.length}
- Articles:
${articleList}

Recent conversation history:
${recentHistory || '(first conversation)'}

IMPORTANT: When you need to take a blog action, include it in your JSON response.
Return ONLY valid JSON (no markdown fences, no extra text):
{
  "reply": "Your natural, conversational email reply",
  "actions": [
    {"type": "write_article", "topic": "...", "details": "any specific instructions"},
    {"type": "edit_article", "slug": "exact-slug-from-list", "instructions": "what to change"},
    {"type": "delete_article", "slug": "exact-slug-from-list"}
  ]
}

If no blog action is needed (just chatting, answering questions, etc.), return empty actions array: []
Keep replies friendly, concise, and helpful. You ARE the blog editor -- be opinionated about content.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `New email received:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody:\n${email.body}`,
      }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Parse JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log('  Warning: AI returned non-JSON, using as plain reply');
    return { reply: text || 'Sorry, I had trouble processing that. Could you try again?', actions: [] };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('  Warning: JSON parse failed, using raw text');
    return { reply: text, actions: [] };
  }
}

// --------------- Action Executor ---------------

async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'write_article': {
          console.log(`  Action: write_article -- "${action.topic}"`);
          const result = await writeNewArticle(action.topic, action.details);
          results.push(result);
          break;
        }
        case 'edit_article': {
          console.log(`  Action: edit_article -- "${action.slug}"`);
          const result = await editExistingArticle(action.slug, action.instructions);
          results.push(result);
          break;
        }
        case 'delete_article': {
          console.log(`  Action: delete_article -- "${action.slug}"`);
          results.push(`(Delete not implemented yet for safety -- slug: ${action.slug})`);
          break;
        }
        default:
          console.log(`  Unknown action type: ${action.type}`);
      }
    } catch (err) {
      console.error(`  Action failed (${action.type}): ${err.message}`);
      results.push(`Action failed: ${err.message}`);
    }
  }

  return results;
}

async function writeNewArticle(topic, details) {
  const topicObj = { topic, summary: details || topic, sources: [] };

  let articleData = await blog.writeArticle(topicObj);
  console.log(`  Title: "${articleData.title}"`);

  const urlResults = await blog.validateURLs(articleData.sources || []);
  const quality = await blog.checkQuality(null, articleData, urlResults);
  articleData = quality.articleData;

  const slug = blog.today() + '-' + blog.slugify(articleData.slug || articleData.title);
  const articleDir = path.join(blog.DOCS, 'articles', slug);
  fs.mkdirSync(articleDir, { recursive: true });

  const article = {
    title: articleData.title,
    metaDescription: articleData.metaDescription,
    slug,
    date: blog.today(),
    displayDate: blog.displayDate(),
    tags: articleData.tags || ['AI Tools'],
    sources: articleData.sources || [],
    qualityScore: quality.score,
    topicConfidence: 10,
  };

  const imagePath = path.join(articleDir, 'featured.png');
  await blog.generateImage(articleData.imagePrompt || topic, imagePath);

  const articleHtml = blog.buildArticlePage(article, articleData);
  fs.writeFileSync(path.join(articleDir, 'index.html'), articleHtml);

  const articles = blog.loadArticles();
  articles.push(article);
  blog.saveArticles(articles);

  fs.writeFileSync(path.join(blog.DOCS, 'index.html'), blog.buildHomepage(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'rss.xml'), blog.buildRSS(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'sitemap.xml'), blog.buildSitemap(articles));

  gitDeploy(`Email-editor: new article "${article.title}"`);

  const url = `${BLOG_URL}/articles/${slug}/`;
  return `Article published! "${article.title}" -- ${url} (Quality: ${quality.score}/10)`;
}

async function editExistingArticle(slug, instructions) {
  const articles = blog.loadArticles();
  let article = articles.find(a => a.slug === slug);
  if (!article) {
    article = articles.find(a => a.slug.includes(slug) || a.title.toLowerCase().includes((slug || '').toLowerCase()));
  }
  if (!article) {
    return `Could not find article matching "${slug}". Available: ${articles.map(a => a.slug).join(', ')}`;
  }

  const articleDir = path.join(blog.DOCS, 'articles', article.slug);
  const htmlPath = path.join(articleDir, 'index.html');
  if (!fs.existsSync(htmlPath)) return `Article HTML not found at ${htmlPath}`;

  const existingHtml = fs.readFileSync(htmlPath, 'utf8');
  const contentMatch = existingHtml.match(/<div class="article-body">([\s\S]*?)<\/div>\s*<footer/);
  const existingContent = contentMatch ? contentMatch[1].trim() : '';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are Franz Enzenhofer rewriting an article on your AI blog. Apply these changes:

INSTRUCTIONS: ${instructions}

CURRENT ARTICLE:
Title: ${article.title}
Content (HTML): ${existingContent.slice(0, 3000)}

Return ONLY valid JSON:
{
  "title": "updated title (50-65 chars)",
  "metaDescription": "updated meta (155-160 chars)",
  "content": "full rewritten article in markdown",
  "tags": ["tag1", "tag2"],
  "sources": [{"name": "...", "url": "..."}],
  "imagePrompt": "image description"
}`
      }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return 'Failed to rewrite article -- AI returned invalid response.';

  const articleData = JSON.parse(jsonMatch[0]);
  article.title = articleData.title || article.title;
  article.metaDescription = articleData.metaDescription || article.metaDescription;
  article.tags = articleData.tags || article.tags;
  article.sources = articleData.sources || article.sources;

  const articleHtml = blog.buildArticlePage(article, articleData);
  fs.writeFileSync(htmlPath, articleHtml);
  blog.saveArticles(articles);

  fs.writeFileSync(path.join(blog.DOCS, 'index.html'), blog.buildHomepage(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'rss.xml'), blog.buildRSS(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'sitemap.xml'), blog.buildSitemap(articles));

  gitDeploy(`Email-editor: reworked "${article.title}"`);

  return `Article reworked! "${article.title}" -- ${BLOG_URL}/articles/${article.slug}/`;
}

// --------------- SMTP Reply ---------------

async function sendReply(originalEmail, replyBody) {
  // Figure out who to reply to
  const fromMatch = originalEmail.from.match(/<([^>]+)>/);
  const replyTo = fromMatch ? fromMatch[1] : originalEmail.from.trim();

  const subject = `Re: ${originalEmail.subject}`;
  const date = new Date().toUTCString();
  const msg = [
    `From: Franz AI Blog Editor <${SMTP_FROM}>`,
    `To: ${replyTo}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    replyBody,
    ``,
    `-- Franz AI Blog Editor`,
  ].join('\r\n');

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP timeout')), 30000);
      const sock = net.createConnection(587, SMTP_HOST);
      let tlsSock = null;
      let step = 0;

      function send(data) { (tlsSock || sock).write(data + '\r\n'); }

      function onData(chunk) {
        const lines = chunk.toString();
        if (/^[45]\d\d /.test(lines) && step > 2) {
          clearTimeout(timeout);
          reject(new Error(`SMTP error at step ${step}: ${lines.trim()}`));
          return;
        }
        if (step === 0 && lines.startsWith('220')) {
          step++; send('EHLO localhost');
        } else if (step === 1 && lines.includes('250')) {
          step++; send('STARTTLS');
        } else if (step === 2 && lines.startsWith('220')) {
          step++;
          tlsSock = tls.connect({ socket: sock, servername: SMTP_HOST }, () => {
            send('EHLO localhost');
          });
          tlsSock.on('data', onData);
          tlsSock.on('error', reject);
        } else if (step === 3 && lines.includes('250')) {
          step++;
          const creds = Buffer.from(`\0${SMTP_USER}\0${SMTP_PASS}`).toString('base64');
          send(`AUTH PLAIN ${creds}`);
        } else if (step === 4 && lines.startsWith('235')) {
          step++; send(`MAIL FROM:<${SMTP_FROM}>`);
        } else if (step === 5 && lines.startsWith('250')) {
          step++; send(`RCPT TO:<${replyTo}>`);
        } else if (step === 6 && lines.startsWith('250')) {
          step++; send('DATA');
        } else if (step === 7 && lines.startsWith('354')) {
          step++; send(msg + '\r\n.');
        } else if (step === 8 && lines.startsWith('250')) {
          step++; send('QUIT');
          clearTimeout(timeout);
          resolve();
        }
      }

      sock.on('data', onData);
      sock.on('error', reject);
      sock.on('close', () => { clearTimeout(timeout); });
    });
    console.log(`  Reply sent to ${replyTo}`);
  } catch (e) {
    console.error(`  Reply failed: ${e.message}`);
  }
}

// --------------- Git Deploy ---------------

function gitDeploy(commitMessage) {
  try {
    const cwd = __dirname;
    execSync('git add -A', { cwd, stdio: 'pipe' });
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd, stdio: 'pipe' });
    execSync('git push', { cwd, stdio: 'pipe' });
    console.log('  Git: committed and pushed');
  } catch (e) {
    console.error(`  Git deploy warning: ${e.message}`);
  }
}

// --------------- Main Loop ---------------

async function processEmail(email) {
  console.log(`  From: ${email.from}`);
  console.log(`  Subject: ${email.subject}`);
  console.log(`  Body: ${email.body.slice(0, 100)}...`);

  // Ask the AI assistant (one Sonnet call does everything)
  console.log('  Asking Claude Sonnet...');
  const response = await askAssistant(email);
  console.log(`  Reply: ${response.reply.slice(0, 80)}...`);
  console.log(`  Actions: ${response.actions.length}`);

  // Execute any blog actions
  let actionResults = [];
  if (response.actions.length > 0) {
    actionResults = await executeActions(response.actions);
  }

  // Build final reply (conversational reply + action results)
  let finalReply = response.reply;
  if (actionResults.length > 0) {
    finalReply += '\n\n--- Action Results ---\n' + actionResults.join('\n');
  }

  // Send reply email
  await sendReply(email, finalReply);

  // Save to conversation history
  addToHistory({
    date: new Date().toISOString(),
    from: email.from,
    subject: email.subject,
    body: email.body.slice(0, 500),
    reply: response.reply.slice(0, 500),
    actions: response.actions,
  });
}

async function pollLoop() {
  console.log('=== Franz AI Blog Email Assistant ===');
  console.log(`IMAP: ${IMAP_USER} (every ${POLL_INTERVAL / 1000}s)`);
  console.log(`SMTP: sending FROM ${SMTP_FROM}`);
  console.log(`Accepting: ${ALLOWED_SENDERS.join(', ')}`);
  console.log(`Blog: ${BLOG_URL}`);
  console.log(`Model: Claude Sonnet (full conversational AI)`);
  console.log('');

  if (!ANTHROPIC_KEY) {
    console.error('Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY_1');
    process.exit(1);
  }

  let pollCount = 0;

  while (true) {
    pollCount++;
    const time = new Date().toLocaleTimeString();

    try {
      const emails = await checkInbox();

      if (emails.length === 0) {
        if (pollCount === 1 || pollCount % 10 === 0) {
          console.log(`[${time}] Poll #${pollCount} -- inbox OK, no new mail`);
        }
      } else {
        console.log(`\n[${time}] ${emails.length} new email(s)!`);
        for (const email of emails) {
          await processEmail(email);
        }
        console.log('');
      }
    } catch (err) {
      console.error(`[${time}] Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

pollLoop();
