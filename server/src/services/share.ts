import { eq, or, and } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { feeds } from "../db/schema";
import { extractImage } from "../utils/image";

/**
 * 分享页服务
 *
 * 背景：前端是 SPA（Cloudflare Pages），服务器返回的 HTML 里没有任何文章信息，
 * 导致社交平台（微信/QQ/微博等）抓取文章链接时拿不到标题与封面，
 * 分享出去只有一条光秃秃的链接。
 *
 * 本服务提供 /s/:id 路由：
 *   - 爬虫 / 社交平台：返回带完整 Open Graph 元信息的 HTML（不执行 JS 也能读到）
 *   - 真实用户：302 跳转到前端文章页 /feed/:id
 *
 * 注意：/s/:id 的 meta 中 canonical 指向 /feed/:id，
 * 因此搜索引擎会把权重归到真正的文章页，不会产生重复内容。
 */

const MAX_TEXT = 300;

function escapeHtml(input: string): string {
    return String(input)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncate(input: string, max: number = MAX_TEXT): string {
    const text = String(input || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function ShareService(): Hono {
    const app = new Hono();

    // GET /s/:id  —— 文章分享页（id 或 alias 均可）
    app.get("/:id", async (c: AppContext) => {
        const idOrAlias = c.req.param("id");
        const db = c.get("db");
        const env = c.get("env");
        const clientConfig = c.get("clientConfig");

        const siteName =
            (await clientConfig.get("site.name")) ||
            (env as unknown as Record<string, string>).NAME ||
            "Rin";
        const siteDescription =
            (await clientConfig.get("site.description")) || "";

        // 前台地址：优先使用配置的 FRONTEND_URL，否则用当前请求的 origin
        const frontendUrl =
            env.FRONTEND_URL?.trim().replace(/\/+$/, "") ||
            new URL(c.req.url).origin;

        // 查询文章：同时兼容数字 id 与 alias
        const numericId = Number.parseInt(idOrAlias, 10);
        const condition = Number.isFinite(numericId)
            ? or(eq(feeds.id, numericId), eq(feeds.alias, idOrAlias))
            : eq(feeds.alias, idOrAlias);

        const feed = await db.query.feeds.findFirst({
            where: and(condition, eq(feeds.draft, 0)),
        });

        if (!feed) {
            // 找不到就回到前端首页，不让用户看到死页
            return c.redirect(`${frontendUrl}/`, 302);
        }

        const articleUrl = `${frontendUrl}/feed/${feed.id}`;
        const title = feed.title || siteName;
        const description = truncate(
            feed.summary || feed.ai_summary || siteDescription || title,
        );
        // 取正文中第一张图片作为分享封面
        const cover = extractImage(feed.content || "");
        const image = cover || `${frontendUrl}/og-image.jpg`;
        const shareUrl = `${frontendUrl}/s/${feed.id}`;

        const isImageAbsolute = /^https?:\/\//i.test(image);
        const absoluteImage = isImageAbsolute
            ? image
            : `${frontendUrl}${image.startsWith("/") ? "" : "/"}${image}`;

        const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} - ${escapeHtml(siteName)}</title>
    <meta name="description" content="${escapeHtml(description)}" />

    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${escapeHtml(siteName)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(articleUrl)}" />
    <meta property="og:image" content="${escapeHtml(absoluteImage)}" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta property="og:locale" content="zh_CN" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(absoluteImage)}" />

    <link rel="canonical" href="${escapeHtml(articleUrl)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(articleUrl)}" />
    <script>location.replace(${JSON.stringify(articleUrl)});</script>
  </head>
  <body>
    <p>正在跳转到 <a href="${escapeHtml(articleUrl)}">${escapeHtml(title)}</a>…</p>
  </body>
</html>`;

        // 说明：爬虫只读 HTML 不执行 JS，因此拿到 meta 后不会跳转；
        // 真实用户会被 meta refresh / script 立即带到文章页。
        return c.html(html, 200, {
            "Cache-Control": "public, max-age=300",
        });
    });

    return app;
}
