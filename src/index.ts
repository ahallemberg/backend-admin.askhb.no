/*
 * The Browser Run binding, typed to the single call this worker makes.
 * worker-configuration.d.ts predates the binding, and regenerating it pulls a
 * whole runtime type surface in for one method.
 */
interface BrowserBinding {
    quickAction(action: "screenshot", options: Record<string, unknown>): Promise<Response>;
}

export interface Env {
    MAIN_BUCKET: R2Bucket;
    AUTH_KEY_SECRET: string;
    BROWSER: BrowserBinding;
    // Comma-separated hosts /screenshot may render, matched exactly. See
    // hostAllowed below.
    SCREENSHOT_HOSTS: string;
}

const hasValidHeader = (request: Request, env: Env): boolean => {
    return request.headers.get("X-Custom-API-Key") === env.AUTH_KEY_SECRET;
};

function authorizeRequest(request: Request, env: Env, key: string): boolean {
    switch (request.method) {
        case "PUT":
            return hasValidHeader(request, env);
        default:
            return false;
    }
}

const SCREENSHOT_PATH = "/screenshot";

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, POST',
};

/*
 * A desktop viewport at exactly the 16:10 the portfolio card crops its
 * screenshot to, so the stored image needs no cropping and arrives showing the
 * desktop layout -- a narrow viewport would capture the phone one instead.
 */
const VIEWPORT = { width: 1280, height: 800 };

/*
 * The hosts a capture may be pointed at, matched exactly.
 *
 * Exact rather than by suffix: accepting every subdomain would mean any
 * subdomain that ever falls out of the owner's hands -- a stale DNS record, a
 * delegation to some third-party host -- becomes a page this worker renders and
 * then stores under askhb.no. The `www.` spellings are listed instead.
 *
 * Note what this does not constrain. It pins the URL the renderer is *sent to*,
 * and the renderer follows redirects, so a redirect off an allowed host is
 * rendered from somewhere this list never approved. The quick action returns
 * only the image, so the worker cannot see where the browser ended up; closing
 * that gap means not letting the caller name a URL at all.
 */
const hostAllowed = (host: string, env: Env): boolean => {
    const allowed = (env.SCREENSHOT_HOSTS ?? "")
        .split(",")
        .map(entry => entry.trim().toLowerCase())
        .filter(entry => entry !== "");

    return allowed.includes(host);
};

/*
 * Where a capture may land. R2 keys are opaque strings -- `..` is a literal
 * segment of a name rather than a parent directory -- so this is not traversal
 * defence. It keeps this route's writes inside `screenshots/`, off the content
 * files the site reads, and in a shape the admin app can predict.
 */
const SAFE_KEY = /^screenshots\/[a-z0-9][a-z0-9/_-]{0,110}$/;

/*
 * Forcing dark without a real user click.
 *
 * The obvious mechanism -- emulating prefers-color-scheme -- is not available:
 * the quick action validates its input strictly and rejects
 * `emulateMediaFeatures` outright. What is left is running a script after
 * navigation, so this sets the two things a site reads for an explicit choice:
 * an attribute on <html>, which is what veivett.no keys off, and a class, which
 * is the other common spelling. Both are plain CSS selectors, so the page
 * repaints as soon as the script runs and before the capture is taken.
 *
 * This can only surface a dark mode the site already has. trafikkskiltene.no
 * has none by any mechanism, so asking for its dark theme captures the ordinary
 * light page and stores it under a `-dark` key. Nothing here can detect that,
 * which is why a site with no dark variant must not be sent `themes: ["dark"]`.
 */
const DARK_SCRIPT = "document.documentElement.setAttribute('data-theme','dark');"
    + "document.documentElement.classList.add('dark');";

const darkOptions = {
    addScriptTag: [{ content: DARK_SCRIPT }],
};

/*
 * Transitions are switched off, and the page is given a moment to settle, before
 * the shot is taken.
 *
 * Forcing dark flips the theme after the page has already painted in light, so
 * anything carrying a CSS transition animates towards its dark value instead of
 * jumping to it. veivett.no's class cards do exactly that: a capture taken
 * straight after the flip caught them 69.5% of the way between the two
 * palettes, an even interpolation on all three channels, showing a colour that
 * exists in neither theme on a page that otherwise looked correct. It is the
 * kind of wrong that survives review, because nothing about it looks broken.
 *
 * Ordering does not matter, which is worth stating because it looks like it
 * should. When a property stops being transitionable the running transition is
 * cancelled and the element renders its after-change style at once, so the rule
 * snaps whatever is in flight to its final value whenever it lands -- before the
 * flip or after it.
 *
 * Animations need their own treatment, because none of the above touches them.
 * They are made to finish rather than switched off: `animation: none` drops an
 * element back to however it looks before its animation runs, which for the
 * common reveal -- a base rule holding it at zero opacity, an animation fading
 * it in -- is an invisible element. Running it to completion in a fraction of a
 * millisecond lands on the end state whichever way the page is written. This is
 * the rule a site applies for readers who ask for reduced motion, so the
 * resting state is one its author chose.
 *
 * That matters on the page this was tuned against: its reveal runs 550ms on
 * twelve elements with staggered delays out to 530ms, settling around 1080ms.
 * Waiting that out would have meant a wait nearly twice this one and still no
 * guarantee -- the bundle also carries infinite spin and pulse keyframes, which
 * no wait makes deterministic.
 *
 * Applied to every capture rather than only the dark one. The pair is the same
 * screenshot in two palettes, so both have to be produced the same way: a
 * difference in method between them would read as a difference in the site.
 */
const NO_TRANSITIONS = "*,*::before,*::after{transition:none !important;"
    + "animation-duration:.001ms !important;animation-delay:0s !important;"
    + "animation-iteration-count:1 !important}";

/*
 * Not for CSS transitions or CSS animations -- the rule above settles those
 * whatever their duration. This is for everything it cannot reach: motion
 * driven from script, whether through the Web Animations API or by writing
 * inline styles frame by frame, and the ordinary business of a late layout
 * pass, a lazily loaded image, or a webfont swapping in.
 */
const SETTLE_MS = 600;

/*
 * When the page counts as loaded, in the order the conditions are tried.
 *
 * `networkidle0` -- zero connections for 500ms -- was the original choice and
 * is the wrong precondition, because a page is free never to satisfy it. Some
 * pages hold a connection open for as long as they are on screen, and
 * veivett.no/klasse/bil is one: it paints in about 2.4s, finishes every request
 * Resource Timing can see by then, and still had a connection open at 55s. The
 * navigation therefore never resolved, Browser Run answered 422 with
 * "Navigation timeout of 30000 ms exceeded", and the capture failed with no
 * image at all -- for a page that had been sitting there fully rendered for
 * most of a minute. The front pages of the same two sites do reach idle, which
 * is why this looked like a bug about custom URLs.
 *
 * `networkidle2` allows up to two such connections, which is the case it was
 * added for, and it settles that page at ~3.0s. It is strictly weaker than
 * networkidle0 -- anything that satisfied the old condition satisfies this one
 * no later -- so no capture that worked before waits longer now.
 *
 * `load` is second because networkidle2 is a looser version of the same
 * unsatisfiable shape rather than a fix for it: a page holding three
 * connections open would fail exactly as before. `load` is the one condition a
 * page cannot withhold, so a capture can no longer fail on the wait alone. It
 * is a fallback and not the primary because it fires before the tail of the
 * page's own loading -- five of that page's 64 requests land after it -- and
 * SETTLE_MS is sized for motion, not for a page still fetching itself.
 */
const WAIT_UNTIL = ["networkidle2", "load"] as const;

/*
 * The navigation timeout is the only failure a looser condition can fix.
 * Browser Run reports it as 422 with error code 6002; a rate limit, a rejected
 * option or an upstream fault is not something a different `waitUntil` helps
 * with, and retrying one would spend a second browser session to fail the same
 * way. Read from the parsed body rather than by matching text, so that
 * reformatted JSON does not quietly turn the retry off.
 */
const NAVIGATION_TIMEOUT_CODE = 6002;

const isNavigationTimeout = (status: number, body: string): boolean => {
    if (status !== 422) return false;
    try {
        const parsed = JSON.parse(body) as { errors?: unknown };
        return Array.isArray(parsed.errors)
            && parsed.errors.some(entry =>
                typeof entry === "object" && entry !== null
                && (entry as { code?: unknown }).code === NAVIGATION_TIMEOUT_CODE);
    } catch {
        return false;
    }
};

/*
 * Upstream's own words go to the log rather than into the response -- the
 * caller can act on the status alone. Only a text body is worth logging:
 * reading an image as text corrupts it and the runtime warns about it, so a
 * binary body is described rather than quoted.
 */
const describeBody = async (response: Response): Promise<string> => {
    const type = response.headers.get("content-type") ?? "";
    return type.startsWith("image/")
        ? `${type} body`
        : (await response.text()).slice(0, 500);
};

type Theme = "light" | "dark";

// Also the capture order, and the only two values there are -- which is what
// caps the loop below at two however many the caller asked for.
const THEMES: Theme[] = ["light", "dark"];

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: Uint8Array): boolean =>
    bytes.length > PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

const capture = async (env: Env, url: string, theme: Theme): Promise<ArrayBuffer> => {
    for (const [index, waitUntil] of WAIT_UNTIL.entries()) {
        const response = await env.BROWSER.quickAction("screenshot", {
            url,
            viewport: VIEWPORT,
            gotoOptions: { waitUntil, timeout: 30000 },
            screenshotOptions: { type: "png" },
            addStyleTag: [{ content: NO_TRANSITIONS }],
            waitForTimeout: SETTLE_MS,
            ...(theme === "dark" ? darkOptions : {}),
        });

        if (!response.ok) {
            const body = await describeBody(response);
            console.error(`Browser Run ${response.status} for ${url} on ${waitUntil}: ${body}`);

            // The last condition has nothing looser to fall back to, so its
            // timeout is a real failure rather than a reason to try again.
            if (isNavigationTimeout(response.status, body) && index < WAIT_UNTIL.length - 1) {
                continue;
            }
            throw new Error(`Browser Run returned ${response.status}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/png")) {
            console.error(`Browser Run sent ${contentType} for ${url}: ${await describeBody(response)}`);
            throw new Error(`Expected image/png, got "${contentType}"`);
        }

        /*
         * The bytes are checked, not just the declared type. An empty body, or one
         * that is some other format, otherwise stores as a permanent broken object
         * under a .png key -- there is no delete here to take it back, and the only
         * signal the caller would get is a success.
         */
        const image = await response.arrayBuffer();
        if (!isPng(new Uint8Array(image))) {
            throw new Error(`Response was ${image.byteLength} bytes and did not begin with a PNG header`);
        }

        return image;
    }

    // Unreachable: every iteration returns, throws, or is followed by another.
    // TypeScript cannot see that WAIT_UNTIL is not empty, and a bare fall-out
    // would type as undefined.
    throw new Error("No wait condition was tried");
};

const badRequest = (message: string) =>
    new Response(message, { status: 400, headers: CORS_HEADERS });

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

const handleScreenshot = async (request: Request, env: Env): Promise<Response> => {
    if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    if (!hasValidHeader(request, env)) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return badRequest("Body must be JSON");
    }

    // `null` is valid JSON, so this is what stops the field reads below from
    // throwing on it -- an uncaught throw here is a 500, not the 400 intended.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return badRequest("Body must be a JSON object");
    }

    const { url, key, themes: requested } = body as { url?: unknown; key?: unknown; themes?: unknown };

    if (typeof url !== "string" || typeof key !== "string") {
        return badRequest("url and key are required");
    }

    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return badRequest("url is not a URL");
    }

    // http would render, but every site this is pointed at is https. Note an
    // https URL that redirects to http is still followed; see hostAllowed.
    if (target.protocol !== "https:") {
        return badRequest("url must be https");
    }

    if (!hostAllowed(target.hostname.toLowerCase(), env)) {
        return badRequest(`${target.hostname} is not in SCREENSHOT_HOSTS`);
    }

    if (!SAFE_KEY.test(key)) {
        return badRequest("key must be under screenshots/ and use [a-z0-9/_-]");
    }

    /*
     * Rejected rather than filtered, and deduplicated.
     *
     * Filtering meant a typo answered 200 for work that never happened: the
     * caller then cache-busts a key holding nothing, or holding the previous
     * run's image. Deduplicating is for a different reason -- the caller decides
     * how many captures one request makes, and each is a real browser session
     * against a small daily allowance shared by the whole account.
     */
    let themes: Theme[] = ["light"];
    if (requested !== undefined) {
        if (!Array.isArray(requested) || requested.length === 0 || !requested.every(isTheme)) {
            return badRequest('themes must be a non-empty array of "light" and/or "dark"');
        }
        themes = THEMES.filter(theme => requested.includes(theme));
    }

    /*
     * At most two captures, and one at a time. Browser Run allows three
     * concurrent browsers for the whole account, so running even a pair
     * concurrently would spend two of them to save a few seconds on a button
     * nobody is watching.
     */
    const stored: { theme: Theme; key: string }[] = [];
    for (const [index, theme] of themes.entries()) {
        const objectKey = `${key}-${theme}.png`;
        try {
            const image = await capture(env, target.toString(), theme);
            await env.MAIN_BUCKET.put(objectKey, image, {
                httpMetadata: { contentType: "image/png" },
            });
            stored.push({ theme, key: objectKey });
        } catch (error) {
            /*
             * Reported rather than undone: there is no delete here, so there is
             * nothing to undo it with.
             *
             * `existing` is the part the caller cannot work out for itself. A
             * failed capture does not mean the key is empty -- an earlier run
             * may have left an image there -- and publishing one cache-busting
             * version across both themes, beside a silently stale one, is
             * exactly how a card ends up half updated.
             */
            const existing = await env.MAIN_BUCKET.head(objectKey) !== null;
            return json({
                stored,
                failed: { theme, key: objectKey, existing },
                skipped: themes.slice(index + 1),
                error: `${error}`,
            }, 502);
        }
    }

    return json({ stored }, 200);
};

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'PUT, POST',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Custom-API-Key',
                'Access-Control-Max-Age': '86400',
                },
            });
            }

        const url = new URL(request.url);

        // Ahead of the key handling below, which would otherwise read this path as
        // an R2 key named "screenshot".
        if (url.pathname === SCREENSHOT_PATH) {
            return handleScreenshot(request, env);
        }

        const key = url.pathname.slice(1);

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'PUT',
        }

        if (!authorizeRequest(request, env, key)) {
            return new Response("Forbidden", { status: 403, headers });
        }

        switch (request.method) {
            case "PUT":
                // Store the uploaded Content-Type. Without it R2 serves the object
                // with no type at all and the browser sniffs the bytes, which both
                // breaks anything relying on a declared type and lets an uploaded
                // file be interpreted as something other than what it is.
                await env.MAIN_BUCKET.put(key, request.body, {
                    httpMetadata: {
                        contentType: request.headers.get("content-type") ?? "application/octet-stream"
                    }
                });
                return new Response(`Put ${key} successfully!`, {status: 200, headers});

            default:
                return new Response(`Method Not Allowed `, {
                    status: 405,
                    headers
                });
        }
    },
};
