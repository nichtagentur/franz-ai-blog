#!/usr/bin/env node
// generate.js -- Fully automated AI blog article generator
// Zero dependencies, Node 22+ (uses native fetch)

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, 'docs');
const TEMPLATES = path.join(__dirname, 'templates');
const ARTICLES_JSON = path.join(DOCS, 'articles.json');
const BASE_URL = 'https://nichtagentur.github.io/franz-ai-blog';

// API keys from environment
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY_1;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// SMTP config for email notifications
const SMTP_HOST = process.env.SMTP_HOST || 'mail.easyname.eu';
const SMTP_USER = process.env.SMTP_USER || 'i-am-a-user@nichtagentur.at';
const SMTP_PASS = process.env.SMTP_PASS || 'i_am_an_AI_password_2026';
const EMAIL_FROM = 'ai-assistent@nichtagentur.at';
const EMAIL_TO = 'franz.enzenhofer@fullstackoptimization.com';

// --------------- Helpers ---------------

function loadArticles() {
  try { return JSON.parse(fs.readFileSync(ARTICLES_JSON, 'utf8')); }
  catch { return []; }
}

function saveArticles(articles) {
  fs.writeFileSync(ARTICLES_JSON, JSON.stringify(articles, null, 2));
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function displayDate() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Minimal markdown to HTML
function md2html(md) {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .replace(/^---$/gm, '<hr>')
    .split('\n\n')
    .map(block => {
      block = block.trim();
      if (!block) return '';
      if (block.startsWith('<')) return block;
      return '<p>' + block + '</p>';
    })
    .join('\n');
}

// --------------- API Calls ---------------

async function discoverNews(existingTitles) {
  console.log('[1/8] Discovering trending AI business news...');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': BASE_URL,
    },
    body: JSON.stringify({
      model: 'perplexity/sonar-pro',
      messages: [{
        role: 'user',
        content: `You are a tech news researcher. Find 5 trending AI tools/business news stories from the last 48 hours. Focus on: new AI tool launches, major AI product updates, companies adopting AI in interesting ways, AI workflow tools for business.

Already covered (skip these): ${existingTitles.join(', ') || 'none yet'}

Return ONLY a JSON array of 5 objects, no other text:
[{"topic": "short topic title", "summary": "2-3 sentence summary of the news", "sources": ["url1", "url2"]}]`
      }],
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '[]';
  // Extract JSON from response (might have markdown fences)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Failed to parse news: ' + content.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

async function writeArticle(topic) {
  console.log('[3/8] Writing article with Claude...');
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
        content: `You are Franz Enzenhofer, a digital strategist and AI tools expert writing for your blog "Franz AI Blog". Write a professional, insightful article about the following AI business news.

TOPIC: ${topic.topic}
DETAILS: ${topic.summary}
SOURCES: ${(topic.sources || []).join(', ')}

REQUIREMENTS:
- Write 400-600 words MAX. Short, punchy, scannable.
- Start with a bold TL;DR (1-2 sentences, the key takeaway upfront)
- Get to the point fast -- no filler, no padding
- Use a strong editorial voice -- opinionated, practical, no fluff
- 2-3 short H2 sections maximum
- Include 1-2 practical takeaways for businesses
- Reference sources naturally in the text

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "title": "Article title (50-65 characters)",
  "metaDescription": "Meta description (155-160 characters)",
  "slug": "url-friendly-slug",
  "content": "Full article in markdown (H2 headings with ##, **bold**, *italic*, [links](url), > quotes, - lists)",
  "tags": ["tag1", "tag2", "tag3"],
  "sources": [{"name": "Source Name", "url": "https://..."}],
  "imagePrompt": "A description for generating a featured image (editorial/newspaper style illustration, no text)"
}`
      }],
    }),
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  // Try to extract JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse article: ' + text.slice(0, 300));
  return JSON.parse(jsonMatch[0]);
}

async function generateImage(prompt, outputPath) {
  console.log('[6/8] Generating featured image with Gemini...');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `Generate a bold editorial illustration for a newspaper article. Style: minimalist, high contrast, suitable as a news article hero image. No text or words in the image. Subject: ${prompt}`
        }]
      }],
      generationConfig: {
        responseModalities: ['image', 'text'],
      },
    }),
  });
  const data = await res.json();

  // Find image part in response
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (imagePart) {
    const buf = Buffer.from(imagePart.inlineData.data, 'base64');
    fs.writeFileSync(outputPath, buf);
    console.log('   Image saved: ' + outputPath);
    return true;
  }

  console.log('   Warning: No image generated, creating placeholder.');
  // Create a simple 1x1 PNG as placeholder
  const minPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(outputPath, minPng);
  return false;
}

// --------------- New Quality Pipeline Steps ---------------

// Step 2: Verify topic is real using Claude Haiku
async function verifyTopic(topics) {
  console.log('[2/8] Verifying topics are real news...');
  for (const topic of topics.slice(0, 5)) {
    try {
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
            content: `Is this AI news real and from the last 48 hours? Rate confidence 1-10.

Topic: ${topic.topic}
Summary: ${topic.summary}
Sources: ${(topic.sources || []).join(', ')}

Return ONLY JSON: {"confidence": 8, "reason": "short reason"}`
          }],
        }),
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const result = JSON.parse(match[0]);
        topic._confidence = result.confidence;
        console.log(`   "${topic.topic}" -- confidence: ${result.confidence}/10`);
        if (result.confidence >= 7) {
          console.log(`   PASSED -- using this topic\n`);
          return topic;
        }
      }
    } catch (e) {
      console.log(`   Warning: verification failed for "${topic.topic}": ${e.message}`);
    }
  }
  // Fallback: use first topic with warning
  console.log('   WARNING: No topic scored >= 7, using first topic anyway\n');
  topics[0]._confidence = topics[0]._confidence || 0;
  return topics[0];
}

// Step 4: Validate source URLs with HEAD requests
async function validateURLs(sources) {
  console.log('[4/8] Validating source URLs...');
  if (!sources || sources.length === 0) {
    console.log('   No sources to validate\n');
    return { results: [], allDead: false };
  }
  const results = await Promise.all(sources.map(async (src) => {
    const url = src.url || src;
    const name = src.name || url;
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      const ok = [200, 301, 302, 403].includes(res.status);
      console.log(`   ${ok ? 'OK  ' : 'DEAD'} [${res.status}] ${url}`);
      return { name, url, status: res.status, ok };
    } catch (e) {
      console.log(`   DEAD [ERR] ${url} -- ${e.message}`);
      return { name, url, status: 0, ok: false };
    }
  }));
  const allDead = results.length > 0 && results.every(r => !r.ok);
  if (allDead) console.log('   WARNING: All source URLs are dead!');
  console.log('');
  return { results, allDead };
}

// Step 5: E-E-A-T quality gate -- rate and optionally rewrite
async function checkQuality(article, articleData, urlResults) {
  console.log('[5/8] Quality gate (E-E-A-T check)...');
  const wordCount = (articleData.content || '').split(/\s+/).length;

  // Ask Haiku to rate
  const rateRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Rate this article for Google E-E-A-T quality (Experience, Expertise, Authoritativeness, Trustworthiness). Score 1-10.

Title: ${articleData.title} (${articleData.title.length} chars)
Meta: ${articleData.metaDescription} (${articleData.metaDescription.length} chars)
Word count: ${wordCount}
Dead source URLs: ${urlResults.results.filter(r => !r.ok).length}/${urlResults.results.length}
Content preview: ${(articleData.content || '').slice(0, 500)}

Check: title 50-65 chars, meta 120-160 chars, 400-600 words, sources cited, no fluff.

Return ONLY JSON: {"score": 8, "suggestions": ["suggestion 1", "suggestion 2"]}`
      }],
    }),
  });
  const rateData = await rateRes.json();
  const rateText = rateData.content?.[0]?.text || '';
  const rateMatch = rateText.match(/\{[\s\S]*\}/);
  let score = 7;
  let suggestions = [];
  if (rateMatch) {
    const parsed = JSON.parse(rateMatch[0]);
    score = parsed.score || 7;
    suggestions = parsed.suggestions || [];
  }
  console.log(`   E-E-A-T score: ${score}/10`);
  if (suggestions.length) console.log(`   Suggestions: ${suggestions.join('; ')}`);

  // If score < 7, attempt one rewrite with Sonnet
  if (score < 7) {
    console.log('   Score below 7 -- rewriting with Claude Sonnet...');
    try {
      const rewriteRes = await fetch('https://api.anthropic.com/v1/messages', {
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
            content: `Rewrite this article to improve its quality. Apply these suggestions:
${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Current article JSON:
${JSON.stringify(articleData)}

Return the COMPLETE rewritten article as valid JSON with the same structure (title, metaDescription, slug, content, tags, sources, imagePrompt). No markdown fences.`
          }],
        }),
      });
      const rewriteData = await rewriteRes.json();
      const rewriteText = rewriteData.content?.[0]?.text || '';
      const rewriteMatch = rewriteText.match(/\{[\s\S]*\}/);
      if (rewriteMatch) {
        articleData = JSON.parse(rewriteMatch[0]);
        console.log(`   Rewrite complete. New title: "${articleData.title}"\n`);
      }
    } catch (e) {
      console.log(`   Rewrite failed: ${e.message} -- using original\n`);
    }
  } else {
    console.log('   PASSED\n');
  }
  return { score, suggestions, articleData };
}

// Step 8: Send email notification via SMTP (zero deps, raw sockets)
async function sendEmailNotification(summary) {
  console.log('[8/8] Sending email notification...');
  const net = require('net');
  const tls = require('tls');

  const { title, url, qualityScore, topicConfidence, urlResults, warnings } = summary;

  const urlLines = (urlResults.results || []).map(r =>
    `  ${r.ok ? 'OK  ' : 'DEAD'} [${r.status || 'ERR'}] ${r.url}`
  ).join('\r\n');

  const body = [
    `New article published on Franz AI Blog`,
    ``,
    `Title: ${title}`,
    `URL: ${url}`,
    `Quality Score: ${qualityScore}/10`,
    `Topic Confidence: ${topicConfidence}/10`,
    ``,
    `Sources checked: ${urlResults.results.length}`,
    urlLines || '  (none)',
    ``,
    warnings.length ? `Warnings:\r\n${warnings.map(w => '  - ' + w).join('\r\n')}` : 'No warnings.',
    ``,
    `-- Franz AI Blog Generator`,
  ].join('\r\n');

  const subject = `New Article: ${title}`;
  const date = new Date().toUTCString();
  const msg = [
    `From: Franz AI Blog <${SMTP_USER}>`,
    `To: ${EMAIL_TO}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
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
        // Catch SMTP errors (4xx/5xx) at any step
        if (/^[45]\d\d /.test(lines) && step > 2) {
          clearTimeout(timeout);
          reject(new Error(`SMTP error at step ${step}: ${lines.trim()}`));
          return;
        }
        if (step === 0 && lines.startsWith('220')) {
          step++; send(`EHLO localhost`);
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
          step++; send(`MAIL FROM:<${SMTP_USER}>`);
        } else if (step === 5 && lines.startsWith('250')) {
          step++; send(`RCPT TO:<${EMAIL_TO}>`);
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
    console.log(`   Email sent to ${EMAIL_TO}\n`);
  } catch (e) {
    console.log(`   WARNING: Email failed: ${e.message} -- continuing anyway\n`);
  }
}

// --------------- Build HTML ---------------

function buildArticlePage(article, articleData) {
  let tmpl = fs.readFileSync(path.join(TEMPLATES, 'article.html'), 'utf8');
  const tagsHtml = (articleData.tags || []).map(t => `<span>${t}</span>`).join(' ');

  tmpl = tmpl.replace(/\{\{TITLE\}\}/g, article.title);
  tmpl = tmpl.replace(/\{\{META_DESCRIPTION\}\}/g, article.metaDescription);
  tmpl = tmpl.replace(/\{\{SLUG\}\}/g, article.slug);
  tmpl = tmpl.replace(/\{\{ISO_DATE\}\}/g, article.date);
  tmpl = tmpl.replace(/\{\{DISPLAY_DATE\}\}/g, displayDate());
  tmpl = tmpl.replace(/\{\{TAGS_FIRST\}\}/g, (articleData.tags || ['AI'])[0]);
  tmpl = tmpl.replace(/\{\{IMAGE_ALT\}\}/g, articleData.imagePrompt || article.title);
  tmpl = tmpl.replace(/\{\{CONTENT\}\}/g, md2html(articleData.content));
  tmpl = tmpl.replace(/\{\{TAGS_HTML\}\}/g, tagsHtml);

  return tmpl;
}

function buildHomepage(articles) {
  let tmpl = fs.readFileSync(path.join(TEMPLATES, 'index.html'), 'utf8');

  const sorted = [...articles].sort((a, b) => b.date.localeCompare(a.date));
  const featured = sorted[0];
  const rest = sorted.slice(1);

  let featuredHtml = '';
  if (featured) {
    featuredHtml = `
    <div class="featured-article">
      <img class="featured-image" src="articles/${featured.slug}/featured.png" alt="${featured.title}" loading="eager">
      <div class="meta">${featured.tags?.[0] || 'AI'} &middot; ${featured.displayDate}</div>
      <h2><a href="articles/${featured.slug}/">${featured.title}</a></h2>
      <p class="excerpt">${featured.metaDescription}</p>
    </div>`;
  }

  const cardsHtml = rest.map(a => `
    <div class="article-card">
      <img class="card-image" src="articles/${a.slug}/featured.png" alt="${a.title}" loading="lazy">
      <div class="meta">${a.tags?.[0] || 'AI'} &middot; ${a.displayDate}</div>
      <h3><a href="articles/${a.slug}/">${a.title}</a></h3>
      <p class="excerpt">${a.metaDescription}</p>
    </div>`).join('\n');

  tmpl = tmpl.replace('{{DATELINE}}', displayDate());
  tmpl = tmpl.replace('{{FEATURED}}', featuredHtml);
  tmpl = tmpl.replace('{{CARDS}}', cardsHtml);

  return tmpl;
}

function buildRSS(articles) {
  const sorted = [...articles].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  const items = sorted.map(a => `
    <item>
      <title><![CDATA[${a.title}]]></title>
      <link>${BASE_URL}/articles/${a.slug}/</link>
      <guid>${BASE_URL}/articles/${a.slug}/</guid>
      <pubDate>${new Date(a.date).toUTCString()}</pubDate>
      <description><![CDATA[${a.metaDescription}]]></description>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Franz AI Blog</title>
  <link>${BASE_URL}/</link>
  <description>Practical AI tools, workflows, and strategies for business.</description>
  <language>en</language>
  <atom:link href="${BASE_URL}/rss.xml" rel="self" type="application/rss+xml"/>
  ${items}
</channel>
</rss>`;
}

function buildSitemap(articles) {
  const urls = [
    `<url><loc>${BASE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${BASE_URL}/about/</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`,
    ...articles.map(a =>
      `<url><loc>${BASE_URL}/articles/${a.slug}/</loc><lastmod>${a.date}</lastmod><priority>0.8</priority></url>`
    ),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

// --------------- Main ---------------

async function main() {
  console.log('=== Franz AI Blog Generator ===\n');

  // Check API keys
  if (!OPENROUTER_KEY) { console.error('Missing OPENROUTER_API_KEY'); process.exit(1); }
  if (!ANTHROPIC_KEY) { console.error('Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY_1'); process.exit(1); }
  if (!GEMINI_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

  // Load existing articles
  const articles = loadArticles();
  const existingTitles = articles.map(a => a.title);
  console.log(`Existing articles: ${articles.length}\n`);

  // Step 1: Discover news
  const news = await discoverNews(existingTitles);
  console.log(`   Found ${news.length} topics\n`);

  // Step 2: Verify topic is real
  const topic = await verifyTopic(news);
  const topicConfidence = topic._confidence || 0;

  // Step 3: Write article
  let articleData = await writeArticle(topic);
  console.log(`   Title: "${articleData.title}"\n`);

  // Step 4: Validate source URLs
  const urlResults = await validateURLs(articleData.sources || []);

  // Step 5: Quality gate (E-E-A-T)
  const quality = await checkQuality(null, articleData, urlResults);
  articleData = quality.articleData; // may be rewritten

  // Build article metadata
  const slug = today() + '-' + slugify(articleData.slug || articleData.title);
  const articleDir = path.join(DOCS, 'articles', slug);
  fs.mkdirSync(articleDir, { recursive: true });

  const article = {
    title: articleData.title,
    metaDescription: articleData.metaDescription,
    slug: slug,
    date: today(),
    displayDate: displayDate(),
    tags: articleData.tags || ['AI Tools'],
    sources: articleData.sources || [],
    qualityScore: quality.score,
    topicConfidence: topicConfidence,
  };

  // Step 6: Generate image
  const imagePath = path.join(articleDir, 'featured.png');
  await generateImage(articleData.imagePrompt || topic.topic, imagePath);

  // Step 7: Build and write all HTML
  console.log('[7/8] Building HTML pages...');

  // Article page
  const articleHtml = buildArticlePage(article, articleData);
  fs.writeFileSync(path.join(articleDir, 'index.html'), articleHtml);

  // Update articles list
  articles.push(article);
  saveArticles(articles);

  // Homepage
  const homepageHtml = buildHomepage(articles);
  fs.writeFileSync(path.join(DOCS, 'index.html'), homepageHtml);

  // RSS
  fs.writeFileSync(path.join(DOCS, 'rss.xml'), buildRSS(articles));

  // Sitemap
  fs.writeFileSync(path.join(DOCS, 'sitemap.xml'), buildSitemap(articles));

  console.log('   All pages built.\n');

  // Step 8: Email notification
  const warnings = [];
  if (topicConfidence < 7) warnings.push(`Low topic confidence: ${topicConfidence}/10`);
  if (urlResults.allDead) warnings.push('All source URLs are dead');
  if (quality.score < 7) warnings.push(`Low quality score after rewrite: ${quality.score}/10`);

  await sendEmailNotification({
    title: article.title,
    url: `${BASE_URL}/articles/${slug}/`,
    qualityScore: quality.score,
    topicConfidence,
    urlResults,
    warnings,
  });

  console.log('Done! Article published.\n');
  console.log(`   Slug: ${slug}`);
  console.log(`   Path: docs/articles/${slug}/`);
  console.log(`   URL:  ${BASE_URL}/articles/${slug}/`);
  console.log(`   Quality: ${quality.score}/10 | Confidence: ${topicConfidence}/10\n`);
}

// Run if called directly, export if required as module
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  DOCS, TEMPLATES, ARTICLES_JSON, BASE_URL,
  ANTHROPIC_KEY, GEMINI_KEY, OPENROUTER_KEY,
  SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO,
  loadArticles, saveArticles, slugify, today, displayDate, md2html,
  discoverNews, writeArticle, verifyTopic, validateURLs, checkQuality,
  generateImage, sendEmailNotification,
  buildArticlePage, buildHomepage, buildRSS, buildSitemap,
};
