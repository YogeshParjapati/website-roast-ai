import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Initialize Gemini SDK lazily with telemetry header
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY" || key.trim() === "") {
      throw new Error("GEMINI_API_KEY environment variable is not configured. Please open the Secrets panel in AI Studio and add your API key.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

app.use(express.json());

// Helper to fetch website metadata securely
async function extractMetadata(url: string) {
  try {
    // Basic validation / normalization of URL
    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
    }

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(5000) // 5 seconds timeout
    });
    
    if (!res.ok) {
      return { 
        success: false, 
        error: `HTTP Error ${res.status}: ${res.statusText}`,
        url: targetUrl
      };
    }
    
    const html = await res.text();
    
    // Title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";
    
    // Meta Description
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const description = descMatch ? descMatch[1].trim() : "";
    
    // Meta Keywords
    const keyMatch = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i) ||
                     html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']keywords["']/i);
    const keywords = keyMatch ? keyMatch[1].trim() : "";
    
    // Headings (H1 & H2)
    const h1s: string[] = [];
    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    let match;
    while ((match = h1Regex.exec(html)) !== null && h1s.length < 5) {
      const text = match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (text) h1s.push(text);
    }

    const h2s: string[] = [];
    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    while ((match = h2Regex.exec(html)) !== null && h2s.length < 5) {
      const text = match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (text) h2s.push(text);
    }
    
    // Image count & accessibility validation (missing alt count)
    const imgRegex = /<img([^>]+)>/gi;
    let totalImages = 0;
    let missingAltCount = 0;
    while ((match = imgRegex.exec(html)) !== null && totalImages < 100) {
      totalImages++;
      const attrs = match[1];
      if (!/alt=["']/i.test(attrs) || /alt=["']\s*["']/i.test(attrs)) {
        missingAltCount++;
      }
    }
    
    // Detect technologies
    const tech: string[] = [];
    if (/wp-content|wp-includes/i.test(html)) tech.push("WordPress");
    if (/tailwindcss|tailwind/i.test(html) || html.includes("tailwindcss") || html.includes("@import \"tailwindcss\"")) tech.push("Tailwind CSS");
    if (/_next\/static|__NEXT_DATA__/i.test(html)) tech.push("Next.js");
    if (/react/i.test(html) || /data-reactroot/i.test(html)) tech.push("React");
    if (/bootstrap/i.test(html)) tech.push("Bootstrap");
    if (/jquery/i.test(html)) tech.push("jQuery");
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html)) tech.push("Google Fonts");
    if (/shopify/i.test(html)) tech.push("Shopify");
    if (/google-analytics|googletagmanager/i.test(html)) tech.push("Google Analytics");
    
    // Code patterns for simulated Speed audit
    const inlineStylesCount = (html.match(/style=["']/gi) || []).length;
    const inlineScriptsCount = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []).length;
    
    return {
      success: true,
      url: targetUrl,
      title,
      description,
      keywords,
      h1s,
      h2s,
      totalImages,
      missingAltCount,
      detectedTech: tech,
      inlineStylesCount,
      inlineScriptsCount,
      htmlLength: html.length
    };
  } catch (err: any) {
    return { 
      success: false, 
      error: err.message || String(err),
      url
    };
  }
}

// API Endpoint to Roast the website
app.post("/api/roast", async (req, res) => {
  try {
    const { url, tone = "funny", extraContext = "" } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Website URL is required" });
    }

    // Try fetching the metadata
    const meta = await extractMetadata(url);

    // Formulate a robust audit & roast prompt for Gemini
    const prompt = `You are a legendary, brutally honest website auditor and expert designer.
Analyze and roast this website: ${url}
Requested Roast Tone: "${tone}"
User's additional context/description of what the site does: "${extraContext || "None provided"}"

Here is the technical metadata we extracted directly from fetching the website:
${meta.success ? `
- Success: True
- Page Title: "${meta.title || "Unknown"}"
- Meta Description: "${meta.description || "Unknown"}"
- Meta Keywords: "${meta.keywords || "Unknown"}"
- Header Tags (H1/H2):
  - H1s: ${JSON.stringify(meta.h1s || [])}
  - H2s: ${JSON.stringify(meta.h2s || [])}
- Visual assets: ${meta.totalImages || 0} total images, ${meta.missingAltCount || 0} missing alt tags.
- Code indicators: Detected inline styles count: ${meta.inlineStylesCount || 0}, inline scripts count: ${meta.inlineScriptsCount || 0}, HTML Length: ${meta.htmlLength || 0} bytes.
- Pre-detected Technologies: ${JSON.stringify(meta.detectedTech || [])}
` : `
- Success: False
- Extraction Error: "${meta.error || "Network unreachable / blocked"}"
  (Note: The website could be fully dynamic, protected, or hosted on localhost. Audit based on domain name, user context, and perform Google Search grounding to look up details if it's a real site.)
`}

Provide a detailed, high-fidelity website roast and score audit. Ensure your roast text is hilarious, witty, and deeply customized to the brand or name of the site. Refer to the detected elements or lack thereof.

Use the requested Tone style:
- "brutal": Unforgiving, sharp, hilariously dry sarcasm, absolutely zero mercy. Make them question their life choices.
- "constructive": Funny, sassy, but packed with genuine elite design and technical solutions.
- "funny": Focused on wild design metaphors, jokes, and dramatic developer exaggerations.
- "gordon_ramsay": Roasting like Chef Gordon Ramsay. Call them an "idiot sandwich", yell about "raw unseasoned HTML", lack of contrast, or sloppy margins.
- "pirate": Sassy sea-captain style. Scurvy styles, shipwrecked navigation, and stormy UX.

Ensure your JSON matches the responseSchema exactly. Keep scores realistic but fun:
- UI Score: evaluate layout, visual appeal, alignment.
- UX Score: check headers, structure, forms.
- speed: performance rating based on inline script/style counts, dynamic indicators.
- Accessibility: check alt image counts, heading structure.
- seo: check meta title/description length/existence.
- Color Issues: find color harmony issues (either based on name or guess, or give general color palette roasting advice).
- Font Issues: evaluate font choices or standard layouts.
- Mobilelines Friends: Mobile friendliness (use "mobileFriendliness" key).

Ensure all array elements have highly custom, descriptive properties.`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        uiScore: { type: Type.INTEGER, description: "UI visual design score from 0 to 100." },
        uxScore: { type: Type.INTEGER, description: "UX logic and flow score from 0 to 100." },
        speedScore: { type: Type.INTEGER, description: "Simulated performance / loading speed score from 0 to 100." },
        accessibilityScore: { type: Type.INTEGER, description: "Accessibility compliance score from 0 to 100." },
        seoScore: { type: Type.INTEGER, description: "Search engine optimization score from 0 to 100." },
        overallRating: { type: Type.STRING, description: "A witty verbal rank or grade (e.g. 'F-', 'Idiot Sandwich', 'Hot Mess', 'A+', 'Pristine but Boring')." },
        
        colorIssues: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              issue: { type: Type.STRING, description: "Short title of the visual issue" },
              description: { type: Type.STRING, description: "Sarcastic description and color audit" },
              severity: { type: Type.STRING, description: "high, medium, or low" }
            },
            required: ["issue", "description", "severity"]
          }
        },
        
        fontIssues: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              issue: { type: Type.STRING, description: "Short typography issue name" },
              description: { type: Type.STRING, description: "Hilarious font sizing or family critique" },
              severity: { type: Type.STRING, description: "high, medium, or low" }
            },
            required: ["issue", "description", "severity"]
          }
        },
        
        mobileFriendliness: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER, description: "Mobile responsiveness score from 0 to 100" },
            verdict: { type: Type.STRING, description: "Verdict text describing responsiveness on phone screens" },
            issues: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["score", "verdict", "issues"]
        },
        
        improvementSuggestions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING, description: "Category like UI, UX, Speed, SEO, Accessibility, or Typography" },
              suggestion: { type: Type.STRING, description: "Actionable concrete tip" },
              impact: { type: Type.STRING, description: "high, medium, or low" }
            },
            required: ["category", "suggestion", "impact"]
          }
        },
        
        roastText: { type: Type.STRING, description: "The core hilarious multi-paragraph written roast matching the requested persona and tone." },
        detectedTech: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        },
        siteIdentity: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            brandName: { type: Type.STRING }
          },
          required: ["title", "description", "brandName"]
        }
      },
      required: [
        "uiScore", "uxScore", "speedScore", "accessibilityScore", "seoScore",
        "overallRating", "colorIssues", "fontIssues", "mobileFriendliness",
        "improvementSuggestions", "roastText", "detectedTech", "siteIdentity"
      ]
    };

    const response = await getGenAI().models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 1.0,
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error("No response from Gemini API");
    }

    const parsedResult = JSON.parse(resultText.trim());
    
    // Add real meta indicators if fetched successfully for extra authenticity
    return res.json({
      success: true,
      metaFetched: meta.success,
      extractedUrl: meta.url,
      rawMeta: meta.success ? {
        title: meta.title,
        description: meta.description,
        totalImages: meta.totalImages,
        missingAltCount: meta.missingAltCount,
        detectedTech: meta.detectedTech
      } : null,
      analysis: parsedResult
    });

  } catch (err: any) {
    console.error("Roast error:", err);
    const errMsg = String(err.message || err);
    const isQuota = errMsg.includes("429") || 
                    errMsg.includes("quota") || 
                    errMsg.includes("RESOURCE_EXHAUSTED") || 
                    errMsg.includes("limit") || 
                    (err.status && String(err.status).includes("RESOURCE_EXHAUSTED"));
    
    if (isQuota) {
      return res.status(429).json({
        success: false,
        quotaExceeded: true,
        error: "Gemini API Quota Exceeded (429)",
        details: "The Gemini API key has exceeded its rate limit or free-tier quota. You can wait a minute for the limit to reset, configure your own key in the AI Studio Secrets panel, or use our smart Client-Side Simulation Mode right now!"
      });
    }

    res.status(500).json({ 
      error: "Failed to generate website roast.", 
      details: err.message || String(err) 
    });
  }
});

// Setup dev server or static file serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Website Roast AI running on http://localhost:${PORT}`);
  });
}

startServer();
