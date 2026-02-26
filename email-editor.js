#!/usr/bin/env node
// email-editor.js -- AI Blog Editor controlled via email
// Zero dependencies, Node 22+ (raw IMAP/SMTP sockets)
// Polls ai-assistent@nichtagentur.at every 30 seconds
// Only accepts emails from franz.enzenhofer@fullstackoptimization.com

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
// ai-assistent@nichtagentur.at IMAP auth doesn't work on this server,
// so we use support@ for receiving and reply FROM ai-assistent@ via SMTP
const IMAP_USER = process.env.IMAP_USER || 'support@nichtagentur.at';
const IMAP_PASS = process.env.IMAP_PASS || process.env.SMTP_PASS || 'i_am_an_AI_password_2026';

const ALLOWED_SENDER = process.env.ALLOWED_SENDER || 'franz.enzenhofer@fullstackoptimization.com';
const POLL_INTERVAL = 30000; // 30 seconds
const EDITOR_EMAIL = 'ai-assistent@nichtagentur.at'; // reply-from address

const ANTHROPIC_KEY = blog.ANTHROPIC_KEY;

let imapUser = IMAP_USER;

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

// Send an IMAP command and wait for the tagged response
function imapCommand(sock, tag, cmd) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`IMAP timeout: ${cmd}`)), 15000);
    let buffer = '';

    function onData(chunk) {
      buffer += chunk.toString();
      // Check for tagged response (the line starting with our tag)
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

// Wait for server greeting
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

// Check inbox for unseen emails, return array of {seqNum, from, subject, body}
async function checkInbox() {
  let sock;
  try {
    sock = await imapConnect();
    await imapGreeting(sock);

    // Login
    let tagNum = 1;
    const tag = () => 'A' + String(tagNum++).padStart(3, '0');

    let t = tag();
    let res = await imapCommand(sock, t, `LOGIN ${imapUser} ${IMAP_PASS}`);
    if (res.includes(t + ' NO') || res.includes(t + ' BAD')) {
      throw new Error(`IMAP login failed for ${imapUser}`);
    }

    // Select inbox
    t = tag();
    await imapCommand(sock, t, 'SELECT INBOX');

    // Search for unseen messages
    t = tag();
    res = await imapCommand(sock, t, 'SEARCH UNSEEN');

    // Parse SEARCH response: "* SEARCH 1 5 9"
    const searchLine = res.split('\r\n').find(l => l.startsWith('* SEARCH'));
    if (!searchLine || searchLine.trim() === '* SEARCH') {
      // No unseen messages
      t = tag();
      sock.write(t + ' LOGOUT\r\n');
      sock.end();
      return [];
    }

    const seqNums = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
    const emails = [];

    for (const seqNum of seqNums) {
      // Fetch headers and body
      t = tag();
      res = await imapCommand(sock, t, `FETCH ${seqNum} (BODY[HEADER.FIELDS (FROM SUBJECT DATE TO CONTENT-TRANSFER-ENCODING CONTENT-TYPE)] BODY[TEXT])`);

      const email = parseImapFetch(res, seqNum);

      // Check sender
      if (!isAllowedSender(email.from)) {
        console.log(`  Ignored email from: ${email.from}`);
        t = tag();
        await imapCommand(sock, t, `STORE ${seqNum} +FLAGS (\\Seen)`);
        continue;
      }

      // Mark as seen
      t = tag();
      await imapCommand(sock, t, `STORE ${seqNum} +FLAGS (\\Seen)`);

      emails.push(email);
    }

    // Logout
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

  // Extract header block -- between HEADER.FIELDS and the next BODY or closing paren
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

  // Extract body text -- after BODY[TEXT]
  const bodyMatch = raw.match(/BODY\[TEXT\]\s*\{(\d+)\}\r\n([\s\S]*)/);
  if (bodyMatch) {
    let body = bodyMatch[2];
    // Trim to the literal length if possible
    const literalLen = parseInt(bodyMatch[1]);
    if (literalLen > 0 && body.length > literalLen) {
      body = body.substring(0, literalLen);
    }

    // Check for Content-Transfer-Encoding in headers
    const cteMatch = raw.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = cteMatch ? cteMatch[1].toLowerCase() : '7bit';

    if (encoding === 'quoted-printable') {
      body = decodeQuotedPrintable(body);
    } else if (encoding === 'base64') {
      body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    }

    // If multipart, try to extract text/plain
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
    .replace(/=\r?\n/g, '')  // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeHeader(str) {
  // Decode =?UTF-8?B?...?= and =?UTF-8?Q?...?= encoded headers
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
      // Find the blank line separating headers from content
      const idx = part.indexOf('\r\n\r\n');
      if (idx !== -1) {
        let text = part.substring(idx + 4);
        // Check encoding within this part
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
  // Fallback: return raw body stripped of MIME headers
  return body.replace(/--[\s\S]*?Content-Type:[\s\S]*?\r\n\r\n/g, '').trim();
}

// --------------- Security ---------------

function isAllowedSender(fromHeader) {
  if (!fromHeader) return false;
  const match = fromHeader.match(/<([^>]+)>/);
  const email = match ? match[1] : fromHeader.trim();
  return email.toLowerCase() === ALLOWED_SENDER.toLowerCase();
}

// --------------- Intent Classification (Haiku -- cheap) ---------------

async function classifyIntent(subject, body) {
  const articles = blog.loadArticles();
  const articleList = articles.map(a => `- "${a.title}" (slug: ${a.slug})`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Classify this email into an action for an AI blog editor.

Subject: ${subject}
Body: ${body}

Existing articles:
${articleList || '(none)'}

Return ONLY JSON:
{
  "intent": "write_article|edit_article|list_articles|status|help",
  "topic": "topic to write about (for write_article)",
  "articleSlug": "slug of article to edit (for edit_article, pick best match from list)",
  "details": "any specific instructions from the email"
}`
      }],
    }),
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { intent: 'help', topic: '', articleSlug: '', details: '' };
  return JSON.parse(match[0]);
}

// --------------- Action Handlers ---------------

async function handleWriteArticle(intent) {
  console.log(`  Writing article about: ${intent.topic}`);

  // Create a topic object compatible with writeArticle()
  const topic = {
    topic: intent.topic,
    summary: intent.details || intent.topic,
    sources: [],
  };

  // Write article with Claude Sonnet
  let articleData = await blog.writeArticle(topic);
  console.log(`  Title: "${articleData.title}"`);

  // Validate source URLs
  const urlResults = await blog.validateURLs(articleData.sources || []);

  // Quality check
  const quality = await blog.checkQuality(null, articleData, urlResults);
  articleData = quality.articleData;

  // Build slug and directory
  const slug = blog.today() + '-' + blog.slugify(articleData.slug || articleData.title);
  const articleDir = path.join(blog.DOCS, 'articles', slug);
  fs.mkdirSync(articleDir, { recursive: true });

  const article = {
    title: articleData.title,
    metaDescription: articleData.metaDescription,
    slug: slug,
    date: blog.today(),
    displayDate: blog.displayDate(),
    tags: articleData.tags || ['AI Tools'],
    sources: articleData.sources || [],
    qualityScore: quality.score,
    topicConfidence: 10, // User requested this topic directly
  };

  // Generate image
  const imagePath = path.join(articleDir, 'featured.png');
  await blog.generateImage(articleData.imagePrompt || intent.topic, imagePath);

  // Build HTML
  const articleHtml = blog.buildArticlePage(article, articleData);
  fs.writeFileSync(path.join(articleDir, 'index.html'), articleHtml);

  const articles = blog.loadArticles();
  articles.push(article);
  blog.saveArticles(articles);

  fs.writeFileSync(path.join(blog.DOCS, 'index.html'), blog.buildHomepage(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'rss.xml'), blog.buildRSS(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'sitemap.xml'), blog.buildSitemap(articles));

  // Git deploy
  gitDeploy(`Email-editor: new article "${article.title}"`);

  const url = `${blog.BASE_URL}/articles/${slug}/`;
  return `New article published!\n\nTitle: ${article.title}\nURL: ${url}\nQuality: ${quality.score}/10\n\nThe article is now live on the blog.`;
}

async function handleEditArticle(intent) {
  console.log(`  Editing article: ${intent.articleSlug}`);

  const articles = blog.loadArticles();
  // Find the article by slug (fuzzy match)
  let article = articles.find(a => a.slug === intent.articleSlug);
  if (!article) {
    // Try partial match
    article = articles.find(a => a.slug.includes(intent.articleSlug) || a.title.toLowerCase().includes((intent.articleSlug || '').toLowerCase()));
  }
  if (!article) {
    return `Could not find article matching "${intent.articleSlug}".\n\nAvailable articles:\n${articles.map(a => `- ${a.title} (${a.slug})`).join('\n')}`;
  }

  // Read existing article HTML and extract content
  const articleDir = path.join(blog.DOCS, 'articles', article.slug);
  const htmlPath = path.join(articleDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return `Article HTML not found at ${htmlPath}`;
  }
  const existingHtml = fs.readFileSync(htmlPath, 'utf8');
  // Extract content between article tags
  const contentMatch = existingHtml.match(/<div class="article-body">([\s\S]*?)<\/div>\s*<footer/);
  const existingContent = contentMatch ? contentMatch[1].trim() : '';

  // Ask Sonnet to rewrite
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

INSTRUCTIONS: ${intent.details}

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

  // Update article metadata
  article.title = articleData.title || article.title;
  article.metaDescription = articleData.metaDescription || article.metaDescription;
  article.tags = articleData.tags || article.tags;
  article.sources = articleData.sources || article.sources;

  // Rebuild article HTML
  const articleHtml = blog.buildArticlePage(article, articleData);
  fs.writeFileSync(htmlPath, articleHtml);

  // Save updated articles list
  blog.saveArticles(articles);

  // Rebuild homepage, RSS, sitemap
  fs.writeFileSync(path.join(blog.DOCS, 'index.html'), blog.buildHomepage(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'rss.xml'), blog.buildRSS(articles));
  fs.writeFileSync(path.join(blog.DOCS, 'sitemap.xml'), blog.buildSitemap(articles));

  // Git deploy
  gitDeploy(`Email-editor: reworked "${article.title}"`);

  const url = `${blog.BASE_URL}/articles/${article.slug}/`;
  return `Article reworked!\n\nTitle: ${article.title}\nURL: ${url}\n\nChanges applied: ${intent.details}\nThe updated article is now live.`;
}

function handleListArticles() {
  const articles = blog.loadArticles();
  if (articles.length === 0) return 'No articles published yet.';

  const sorted = [...articles].sort((a, b) => b.date.localeCompare(a.date));
  const list = sorted.map((a, i) =>
    `${i + 1}. ${a.title}\n   Date: ${a.displayDate || a.date}\n   URL: ${blog.BASE_URL}/articles/${a.slug}/\n   Quality: ${a.qualityScore || '?'}/10`
  ).join('\n\n');

  return `Franz AI Blog -- ${articles.length} articles\n\n${list}\n\nBlog: ${blog.BASE_URL}`;
}

function handleStatus() {
  const articles = blog.loadArticles();
  const sorted = [...articles].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0];

  return [
    'Franz AI Blog -- Status',
    '',
    `Total articles: ${articles.length}`,
    `Blog URL: ${blog.BASE_URL}`,
    latest ? `Latest: "${latest.title}" (${latest.date})` : 'No articles yet.',
    '',
    `Email editor: RUNNING`,
    `Polling: every ${POLL_INTERVAL / 1000} seconds`,
    `IMAP account: ${imapUser}`,
    `Accepting emails from: ${ALLOWED_SENDER}`,
  ].join('\n');
}

function handleHelp() {
  return [
    'Franz AI Blog -- Email Editor Commands',
    '',
    'Send an email to ai-assistent@nichtagentur.at with:',
    '',
    '  "Write an article about [topic]"',
    '    -> AI writes, quality-checks, generates image, publishes',
    '',
    '  "Edit/Rework the [article name]: [instructions]"',
    '    -> AI rewrites the article with your instructions',
    '',
    '  "List articles"',
    '    -> Get a list of all published articles',
    '',
    '  "Status"',
    '    -> Blog stats and editor status',
    '',
    '  "Help"',
    '    -> This message',
    '',
    'Only emails from franz.enzenhofer@fullstackoptimization.com are accepted.',
  ].join('\n');
}

// --------------- SMTP Reply ---------------

async function sendReply(originalEmail, replyBody) {
  const subject = `Re: ${originalEmail.subject}`;
  const date = new Date().toUTCString();
  const msg = [
    `From: Franz AI Blog Editor <${blog.SMTP_USER}>`,
    `Reply-To: ${EDITOR_EMAIL}`,
    `To: ${ALLOWED_SENDER}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    replyBody,
    ``,
    `-- Franz AI Blog Email Editor`,
  ].join('\r\n');

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP timeout')), 30000);
      const sock = net.createConnection(587, blog.SMTP_HOST);
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
          tlsSock = tls.connect({ socket: sock, servername: blog.SMTP_HOST }, () => {
            send('EHLO localhost');
          });
          tlsSock.on('data', onData);
          tlsSock.on('error', reject);
        } else if (step === 3 && lines.includes('250')) {
          step++;
          const creds = Buffer.from(`\0${blog.SMTP_USER}\0${blog.SMTP_PASS}`).toString('base64');
          send(`AUTH PLAIN ${creds}`);
        } else if (step === 4 && lines.startsWith('235')) {
          step++; send(`MAIL FROM:<${blog.SMTP_USER}>`);
        } else if (step === 5 && lines.startsWith('250')) {
          step++; send(`RCPT TO:<${ALLOWED_SENDER}>`);
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
    console.log(`  Reply sent to ${ALLOWED_SENDER}`);
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

  // Classify intent with Haiku (cheap, ~200 tokens)
  const intent = await classifyIntent(email.subject, email.body);
  console.log(`  Intent: ${intent.intent}`);

  let result;
  try {
    switch (intent.intent) {
      case 'write_article':
        result = await handleWriteArticle(intent);
        break;
      case 'edit_article':
        result = await handleEditArticle(intent);
        break;
      case 'list_articles':
        result = handleListArticles();
        break;
      case 'status':
        result = handleStatus();
        break;
      case 'help':
      default:
        result = handleHelp();
        break;
    }
  } catch (err) {
    console.error(`  Action failed: ${err.message}`);
    result = `Error processing your request: ${err.message}\n\nSend "help" for available commands.`;
  }

  // Reply via email
  await sendReply(email, result);
}

async function pollLoop() {
  console.log('=== Franz AI Blog Email Editor ===');
  console.log(`Polling: ${IMAP_USER} every ${POLL_INTERVAL / 1000}s`);
  console.log(`Accepting emails from: ${ALLOWED_SENDER}`);
  console.log(`Blog: ${blog.BASE_URL}`);
  console.log('');

  // Check API key
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
        // First poll: confirm working. Then every 10th poll.
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
