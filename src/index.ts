export interface Env {
    MAIN_BUCKET: R2Bucket;
    AUTH_KEY_SECRET: string;
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

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200, 
                headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'PUT',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Custom-API-Key',
                'Access-Control-Max-Age': '86400',
                },
            });
            }
            
        const url = new URL(request.url);
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