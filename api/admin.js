
const REPO = "vsravanthi-dev/ghl-customizer";
const FILE = "config.json";

const GHL_BASE = "https://services.leadconnectorhq.com";

// ==========================================
// GITHUB API
// ==========================================

const gh = (path, opt = {}) =>
  fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghl-customizer-admin",
      "Content-Type": "application/json",
    },
  });

// ==========================================
// READ CONFIGURATION
// ==========================================

async function readConfig() {
  const r = await gh(FILE + "?ref=main");

  if (!r.ok) {
    throw new Error("GitHub read failed (" + r.status + ")");
  }

  const j = await r.json();

  return {
    cfg: JSON.parse(
      Buffer.from(j.content, "base64").toString("utf8")
    ),
    sha: j.sha,
  };
}

// ==========================================
// SAVE CONFIGURATION
// ==========================================

async function writeConfig(cfg, sha, message) {
  const put = await gh(FILE, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(
        JSON.stringify(cfg, null, 2)
      ).toString("base64"),
      sha,
      branch: "main",
    }),
  });

  if (!put.ok) {
    throw new Error("GitHub save failed (" + put.status + ")");
  }
}

const isEmpty = (v) =>
  v === "" ||
  v == null ||
  (Array.isArray(v) && !v.length) ||
  (
    typeof v === "object" &&
    !Array.isArray(v) &&
    !Object.keys(v).length
  );

// ==========================================
// GHL HEADERS
// ==========================================

const ghlHeaders = () => ({
  Authorization:
    "Bearer " + (process.env.GHL_TOKEN || "").trim(),
  Version: "2021-07-28",
  Accept: "application/json",
});

// ==========================================
// GHL ERROR LOGGING
// ==========================================

async function logGhlError(label, response, skip) {
  let message = "";

  try {
    const data = await response.json();

    message = String(
      data.message ||
      data.error ||
      data.statusCode ||
      "No error message returned"
    ).slice(0, 500);

    const token = (process.env.GHL_TOKEN || "").trim();

    if (token) {
      message = message.split(token).join("[REDACTED]");
    }
  } catch (_) {
    message = "Non-JSON error response";
  }

  console.error(label, {
    status: response.status,
    message,
    skip,
  });

  return label + " " + response.status;
}

// ==========================================
// FETCH ALL GHL SUBACCOUNTS
// ==========================================

async function getLocations() {
  const token =
    (process.env.GHL_TOKEN || "").trim();

  const company =
    (process.env.GHL_COMPANY_ID || "").trim();

  if (!token || !company) {
    console.error(
      "GHL_TOKEN or GHL_COMPANY_ID missing"
    );

    return {
      list: [],
      source: "none",
      error: "GHL environment variables missing",
    };
  }

  const accounts = new Map();

  const limit = 100;

  let skip = 0;

  try {
    while (true) {
      const params = new URLSearchParams({
        companyId: company,
        limit: String(limit),
        skip: String(skip),
      });

      const r = await fetch(
        GHL_BASE +
          "/locations/search?" +
          params.toString(),
        {
          method: "GET",
          headers: ghlHeaders(),
          cache: "no-store",
        }
      );

      if (!r.ok) {
        const error = await logGhlError(
          "GHL Locations API failed",
          r,
          skip
        );

        return {
          list: [],
          source: "none",
          error,
        };
      }

      const j = await r.json();

      if (!Array.isArray(j.locations)) {
        throw new Error(
          "Invalid GHL locations response"
        );
      }

      const list = j.locations;

      if (!list.length) break;

      const previousSize = accounts.size;

      list.forEach((l) => {
        if (l.id) {
          accounts.set(l.id, {
            id: l.id,
            name: l.name || l.id,
          });
        }
      });

      if (accounts.size === previousSize) {
        throw new Error(
          "GHL pagination returned duplicate accounts"
        );
      }

      skip += list.length;

      if (list.length < limit) break;
    }

    const list = Array.from(accounts.values()).sort(
      (a, b) => a.name.localeCompare(b.name)
    );

    console.info("GHL locations fetched", {
      count: list.length,
    });

    return {
      list,
      source: "ghl",
      error: "",
    };

  } catch (e) {
    console.error(
      "GHL locations exception:",
      e.message
    );

    return {
      list: [],
      source: "none",
      error: e.message,
    };
  }
}

// ==========================================
// FETCH GHL USERS
// ==========================================

const userName = (u) =>
  (
    u.name ||
    (
      (u.firstName || "") +
      " " +
      (u.lastName || "")
    ).trim() ||
    u.email ||
    ""
  ).trim();

async function getUsers() {
  const token =
    (process.env.GHL_TOKEN || "").trim();

  const company =
    (process.env.GHL_COMPANY_ID || "").trim();

  if (!token) {
    return {
      list: [],
      source: "none",
      error: "GHL_TOKEN not set",
    };
  }

  const map = new Map();

  const add = (list) => {
    (list || []).forEach((u) => {
      if (u.id) {
        map.set(
          u.id,
          userName(u) || "User " + u.id
        );
      }
    });
  };

  let error = "";

  try {
    if (company) {
      let skip = 0;

      const limit = 100;

      while (true) {
        const params = new URLSearchParams({
          companyId: company,
          limit: String(limit),
          skip: String(skip),
        });

        const r = await fetch(
          GHL_BASE +
            "/users/search?" +
            params.toString(),
          {
            headers: ghlHeaders(),
            cache: "no-store",
          }
        );

        if (!r.ok) {
          error = await logGhlError(
            "GHL Users API failed",
            r,
            skip
          );

          break;
        }

        const j = await r.json();

        const list = j.users || [];

        if (!list.length) break;

        const previousSize = map.size;

        add(list);

        if (map.size === previousSize) {
          error = "Duplicate users pagination";
          break;
        }

        skip += list.length;

        if (list.length < limit) break;
      }
    }
  } catch (e) {
    error = e.message;

    console.error(
      "GHL users exception:",
      error
    );
  }

  // Backup: fetch users from each subaccount

  if (!map.size) {
    try {
      const locations = await getLocations();

      const locs = locations.list;

      if (locations.error) {
        error = error || locations.error;
      }

      for (const l of locs) {
        const r = await fetch(
          GHL_BASE +
            "/users/?locationId=" +
            encodeURIComponent(l.id),
          {
            headers: ghlHeaders(),
            cache: "no-store",
          }
        );

        if (r.ok) {
          const j = await r.json();

          add(j.users || []);
        } else {
          error = error || "GHL users " + r.status;
        }
      }

    } catch (e) {
      error = error || e.message;
    }
  }

  const list = Array.from(map.entries())
    .map(([id, name]) => ({
      id,
      name,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name)
    );

  console.info("GHL users fetched", {
    count: list.length,
  });

  return {
    list,
    source: list.length ? "ghl" : "none",
    error: error || (
      list.length ? "" : "No users returned"
    ),
  };
}

// ==========================================
// WEBAPP BRANDING CONFIGURATION
// ==========================================

async function getWebappBranding(locationId) {
  const { cfg } = await readConfig();

  const defaultConfig = cfg.default || {};

  const locationConfig =
    cfg.subaccounts?.[locationId] || {};

  const branding = {
    ...defaultConfig,
    ...locationConfig,
  };

  return {
    appName:
      branding.appName || "Realtee",

    appUrl:
      branding.appUrl || "",

    faviconUrl:
      branding.faviconUrl || "",

    logoUrl:
      branding.logoUrl ||
      branding.agencyLogoUrl ||
      "",

    brandColor:
      branding.brandColor || "#1e293b",

    textColor:
      branding.textColor || "#ffffff",

    activeTextColor:
      branding.activeTextColor ||
      branding.brandColor ||
      "#1e293b",

    settingsLabelColor:
      branding.settingsLabelColor ||
      branding.brandColor ||
      "#1e293b",

    settingsTitleColor:
      branding.settingsTitleColor ||
      "#ffffff",

    whiteIcons:
      branding.whiteIcons ?? true,
  };
}

// ==========================================
// SECURE WEBAPP API KEY COMPARISON
// ==========================================

const crypto = require("crypto");

function secureEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const x = crypto
    .createHash("sha256")
    .update(a)
    .digest();

  const y = crypto
    .createHash("sha256")
    .update(b)
    .digest();

  return crypto.timingSafeEqual(x, y);
}

// ==========================================
// MAIN API HANDLER
// ==========================================

module.exports = async (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {
    const action = req.query.action;

    // ======================================
    // SECURE WEBAPP BRANDING API
    // ======================================

    if (action === "webapp-branding") {
      if (req.method !== "GET") {
        return res.status(405).json({
          error: "Method not allowed",
        });
      }

      const secret =
        process.env.WEBAPP_API_KEY;

      if (!secret) {
        return res.status(503).json({
          error: "Webapp integration not configured",
        });
      }

      const authorization =
        req.headers.authorization;

      if (
        !secureEqual(
          authorization,
          `Bearer ${secret}`
        )
      ) {
        return res.status(401).json({
          error: "Unauthorized",
        });
      }

      const locationId =
        req.query.locationId;

      if (
        typeof locationId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(locationId)
      ) {
        return res.status(400).json({
          error: "Valid locationId is required",
        });
      }

      const branding =
        await getWebappBranding(locationId);

      return res.status(200).json({
        success: true,
        locationId,
        branding,
      });
    }

    // ======================================
    // GET ALL SUBACCOUNTS
    // ======================================

    if (action === "locations") {
      const locations =
        await getLocations();

      return res.json(locations.list);
    }

    // ======================================
    // GET ALL USERS
    // ======================================

    if (action === "users") {
      const users =
        await getUsers();

      return res.json(users.list);
    }

    // ======================================
    // API STATUS
    // ======================================

    if (action === "status") {
      const [l, u] = await Promise.all([
        getLocations(),
        getUsers(),
      ]);

      return res.json({
        passwordSet: false,

        webappIntegrationConfigured:
          !!process.env.WEBAPP_API_KEY,

        locations: {
          source: l.source,
          count: l.list.length,
          error: l.error,
        },

        users: {
          source: u.source,
          count: u.list.length,
          error: u.error,
        },
      });
    }

    // ======================================
    // GET CONFIGURATION
    // ======================================

    if (action === "config") {
      const { cfg } =
        await readConfig();

      return res.json(cfg);
    }

    // ======================================
    // SAVE CONFIGURATION
    // ======================================

    if (
      action === "save" &&
      req.method === "POST"
    ) {
      const {
        scope,
        id,
        ids,
        settings,
      } = req.body || {};

      const targets =
        Array.isArray(ids) && ids.length
          ? ids
          : id
            ? [id]
            : [];

      if (
        ![
          "subaccounts",
          "users",
          "default",
        ].includes(scope) ||
        !targets.length ||
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings)
      ) {
        return res.status(400).json({
          error: "Missing or invalid data",
        });
      }

      const invalidKeys = [
        "__proto__",
        "constructor",
        "prototype",
      ];

      if (
        targets.some(
          (tid) =>
            typeof tid !== "string" ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(tid) ||
            invalidKeys.includes(tid)
        ) ||
        Object.keys(settings).some(
          (key) => invalidKeys.includes(key)
        )
      ) {
        return res.status(400).json({
          error: "Invalid configuration keys",
        });
      }

      const { cfg, sha } =
        await readConfig();

      targets.forEach((tid) => {
        let cur;

        if (scope === "default") {
          cur = Object.assign(
            {},
            cfg.default
          );
        } else {
          cfg[scope] =
            cfg[scope] || {};

          cur = Object.assign(
            {},
            cfg[scope][tid]
          );
        }

        Object.keys(settings).forEach((k) => {
          if (isEmpty(settings[k])) {
            delete cur[k];
          } else {
            cur[k] = settings[k];
          }
        });

        if (scope === "default") {
          cfg.default = cur;

        } else if (Object.keys(cur).length) {
          cfg[scope][tid] = cur;

        } else {
          delete cfg[scope][tid];
        }
      });

      await writeConfig(
        cfg,
        sha,
        "Update " +
          scope +
          " " +
          targets.join(",") +
          " (admin page)"
      );

      return res.json({
        ok: true,
      });
    }

    // ======================================
    // BULK SHOW / HIDE MENUS
    // ======================================

    if (
      action === "bulk" &&
      req.method === "POST"
    ) {
      const {
        id,
        title,
        byTitle,
        mode,
      } = req.body || {};

      if (
        !id ||
        !title ||
        !["show", "hide"].includes(mode)
      ) {
        return res.status(400).json({
          error: "Missing data",
        });
      }

      const key =
        byTitle ? title : id;

      const hideField =
        byTitle
          ? "hideMenuTitles"
          : "hideMenus";

      const without = (arr) =>
        (arr || []).filter(
          (x) => x !== key
        );

      const { cfg, sha } =
        await readConfig();

      cfg.default =
        cfg.default || {};

      cfg.default[hideField] =
        without(cfg.default[hideField]);

      if (mode === "hide") {
        cfg.default[hideField].push(key);
      }

      cfg.default.showMenus =
        without(cfg.default.showMenus);

      [
        "hideMenus",
        "hideMenuTitles",
        "showMenus",
      ].forEach((f) => {
        if (
          !cfg.default[f] ||
          !cfg.default[f].length
        ) {
          delete cfg.default[f];
        }
      });

      ["subaccounts", "users"].forEach(
        (scope) => {
          Object.keys(
            cfg[scope] || {}
          ).forEach((k) => {
            const o =
              cfg[scope][k];

            [
              "hideMenus",
              "hideMenuTitles",
              "showMenus",
            ].forEach((f) => {
              if (Array.isArray(o[f])) {
                o[f] = o[f].filter(
                  (x) => x !== key
                );

                if (!o[f].length) {
                  delete o[f];
                }
              }
            });

            if (!Object.keys(o).length) {
              delete cfg[scope][k];
            }
          });
        }
      );

      await writeConfig(
        cfg,
        sha,
        (
          mode === "hide"
            ? "Hide "
            : "Show "
        ) +
          title +
          " for all (admin page)"
      );

      return res.json({
        ok: true,
      });
    }

    // ======================================
    // UNKNOWN ACTION
    // ======================================

    return res.status(400).json({
      error: "Unknown action",
    });

  } catch (e) {
    console.error(
      "Admin API error:",
      e.message
    );

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
