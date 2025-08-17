export interface Env {
    MY_BUCKET: R2Bucket;
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
        const url = new URL(request.url);
        const key = url.pathname.slice(1);
        
        if (!authorizeRequest(request, env, key)) {
            return new Response("Forbidden", { status: 403 });
        }
        
        switch (request.method) {
            case "PUT":
                await env.MY_BUCKET.put(key, request.body);
                return new Response(`Put ${key} successfully!`);

            default:
                return new Response(`Method Not Allowed `, {
                    status: 405,
                    headers: {
                        Allow: "PUT, GET, DELETE",
                    },
                    
                });
        }
    },
};