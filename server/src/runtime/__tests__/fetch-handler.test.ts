import { afterEach, describe, expect, it, mock } from "bun:test";

const getAppFetch = mock();

mock.module("../app-instance", () => ({
  getApp: () => ({
    fetch: getAppFetch,
  }),
}));

describe("handleFetch", () => {
  afterEach(() => {
    getAppFetch.mockReset();
  });

  it("serves static assets directly when the asset exists", async () => {
    getAppFetch.mockResolvedValue(new Response("app-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 200 }));

    const response = await handleFetch(
      new Request("http://localhost/assets/app.js"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(await response.text()).toBe("asset-body");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(getAppFetch).toHaveBeenCalledTimes(0);
  });

  it("routes /api/blob requests to the app before static assets", async () => {
    getAppFetch.mockResolvedValue(new Response("blob-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 404 }));

    const executionContext = {} as ExecutionContext;
    const response = await handleFetch(
      new Request("http://localhost/api/blob/images/test.txt"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
      executionContext,
    );

    expect(await response.text()).toBe("blob-body");
    expect(getAppFetch).toHaveBeenCalledTimes(1);
    expect(assetFetch).toHaveBeenCalledTimes(0);
    expect(new URL(getAppFetch.mock.calls[0][0].url).pathname).toBe("/blob/images/test.txt");
    expect(getAppFetch.mock.calls[0][2]).toBe(executionContext);
  });

  it("routes /s/:id share pages to the app instead of the SPA fallback", async () => {
    getAppFetch.mockResolvedValue(
      new Response("<html>share</html>", { status: 200 }),
    );

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("spa-shell", { status: 200 }));

    const response = await handleFetch(
      new Request("http://localhost/s/29"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(await response.text()).toBe("<html>share</html>");
    expect(getAppFetch).toHaveBeenCalledTimes(1);
    // 关键：不能落到 SPA 兜底，否则分享卡片拿不到文章元信息
    expect(assetFetch).toHaveBeenCalledTimes(0);
    expect(new URL(getAppFetch.mock.calls[0][0].url).pathname).toBe("/s/29");
  });

  it("still serves the SPA fallback for regular app routes", async () => {
    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("spa-shell", { status: 200 }));

    const response = await handleFetch(
      new Request("http://localhost/feed/29"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(await response.text()).toBe("spa-shell");
    expect(getAppFetch).toHaveBeenCalledTimes(0);
  });
});
