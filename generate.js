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
  console.log('[1/5] Discovering trending AI business news...');
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
  console.log('[2/5] Writing article with Claude...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are Franz Enzenhofer, a digital strategist and AI tools expert writing for your blog "Franz AI Blog". Write a professional, insightful article about the following AI business news.

TOPIC: ${topic.topic}
DETAILS: ${topic.summary}
SOURCES: ${(topic.sources || []).join(', ')}

REQUIREMENTS:
- Write 1500-2500 words, authoritative but accessible to business readers
- Use a strong editorial voice -- opinionated, practical, no fluff
- Include practical implications for businesses
- Reference sources naturally in the text
- Structure with clear H2 headings
- Include specific examples and actionable takeaways

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
  console.log('[3/5] Generating featured image with Gemini...');
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

  // Step 2: Pick best unused topic (first one not matching existing)
  const topic = news[0];
  console.log(`   Selected: "${topic.topic}"\n`);

  // Step 3: Write article
  const articleData = await writeArticle(topic);
  console.log(`   Title: "${articleData.title}"\n`);

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
  };

  // Step 4: Generate image
  const imagePath = path.join(articleDir, 'featured.png');
  await generateImage(articleData.imagePrompt || topic.topic, imagePath);

  // Step 5: Build and write all HTML
  console.log('[4/5] Building HTML pages...');

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

  // Step 6: Git commit
  console.log('[5/5] Done! Article published.\n');
  console.log(`   Slug: ${slug}`);
  console.log(`   Path: docs/articles/${slug}/`);
  console.log(`   URL:  ${BASE_URL}/articles/${slug}/\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
