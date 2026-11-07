package com.approxtech.ai;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Approx AI backend client. Pure java.net + org.json (no Android UI dependencies) so the
 * same class can be exercised from a JVM test harness. All calls are blocking: call them
 * from a background thread.
 *
 * Security: HTTPS is required for every non-test base URL (also enforced by the manifest's
 * network security config). The bearer token is a per-device session token, never an API key.
 */
public class Api {
    public static class ApiException extends Exception {
        public final int status;
        public final String code;
        public ApiException(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    public interface StreamHandler {
        void onRoute(JSONObject route);
        void onDelta(String text);
        void onDone(JSONObject done);
        void onError(String code, String message);
    }

    private final String base;
    private volatile String token;
    private volatile HttpURLConnection activeStream;

    public Api(String baseUrl, String token) {
        this.base = baseUrl.replaceAll("/+$", "");
        this.token = token;
    }

    /** Validates a user-entered server URL. Only https:// is accepted. */
    public static String normalizeServer(String url) throws ApiException {
        String u = url == null ? "" : url.trim().replaceAll("/+$", "");
        if (!u.startsWith("https://")) throw new ApiException(0, "insecure_url", "Server URL must start with https://");
        try { new URL(u); } catch (IOException e) { throw new ApiException(0, "bad_url", "Invalid server URL"); }
        return u;
    }

    public void setToken(String t) { token = t; }
    public String getToken() { return token; }
    public String getBase() { return base; }

    public static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (IOException e) { return s; }
    }

    private HttpURLConnection open(String method, String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            c.setRequestMethod(method);
        } catch (java.net.ProtocolException e) {
            // Some HttpURLConnection implementations reject PATCH: tunnel it (server honours PATCH only).
            if (!"PATCH".equals(method)) throw e;
            c.setRequestMethod("POST");
            c.setRequestProperty("X-HTTP-Method-Override", "PATCH");
        }
        c.setConnectTimeout(15000);
        c.setReadTimeout(180000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", "application/json, text/event-stream");
        c.setRequestProperty("User-Agent", "ApproxAI-Android/1.0.0");
        if (token != null && token.length() > 0) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static ApiException toError(int status, String body) {
        try {
            JSONObject e = new JSONObject(body).getJSONObject("error");
            return new ApiException(status, e.optString("code"), e.optString("message", "Request failed"));
        } catch (JSONException ex) {
            return new ApiException(status, "http_" + status, "Request failed (HTTP " + status + ")");
        }
    }

    public JSONObject request(String method, String path, JSONObject body) throws ApiException {
        HttpURLConnection c = null;
        try {
            c = open(method, path);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(b.length);
                OutputStream os = c.getOutputStream();
                os.write(b);
                os.close();
            }
            int status = c.getResponseCode();
            String text = readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
            if (status >= 400) throw toError(status, text);
            return text.length() == 0 ? new JSONObject() : new JSONObject(text);
        } catch (IOException e) {
            throw new ApiException(0, "network", "Network error: " + e.getMessage());
        } catch (JSONException e) {
            throw new ApiException(0, "bad_response", "Unexpected server response");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public JSONObject get(String path) throws ApiException { return request("GET", path, null); }
    public JSONObject post(String path, JSONObject body) throws ApiException { return request("POST", path, body == null ? new JSONObject() : body); }
    public JSONObject patch(String path, JSONObject body) throws ApiException { return request("PATCH", path, body); }
    public JSONObject delete(String path) throws ApiException { return request("DELETE", path, null); }

    public JSONObject upload(String filename, byte[] data) throws ApiException {
        HttpURLConnection c = null;
        try {
            c = open("POST", "/api/files");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/octet-stream");
            c.setRequestProperty("X-Filename", enc(filename));
            c.setFixedLengthStreamingMode(data.length);
            OutputStream os = c.getOutputStream();
            os.write(data);
            os.close();
            int status = c.getResponseCode();
            String text = readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
            if (status >= 400 && status != 422) throw toError(status, text);
            JSONObject r = new JSONObject(text);
            if (status == 422) throw new ApiException(422, "blocked", "File blocked by security scan: " + r.getJSONObject("file").optString("scan_detail"));
            return r;
        } catch (IOException e) {
            throw new ApiException(0, "network", "Upload failed: " + e.getMessage());
        } catch (JSONException e) {
            throw new ApiException(0, "bad_response", "Unexpected server response");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** POST and consume a Server-Sent Events response. Returns when the stream ends. */
    public void stream(String path, JSONObject body, StreamHandler h) throws ApiException {
        HttpURLConnection c = null;
        try {
            c = open("POST", path);
            activeStream = c;
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            OutputStream os = c.getOutputStream();
            os.write(b);
            os.close();
            int status = c.getResponseCode();
            if (status >= 400) throw toError(status, readAll(c.getErrorStream()));
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String line;
            String event = "message";
            StringBuilder data = new StringBuilder();
            while ((line = r.readLine()) != null) {
                if (line.length() == 0) {
                    if (data.length() > 0) dispatch(event, data.toString(), h);
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
            if (data.length() > 0) dispatch(event, data.toString(), h);
        } catch (IOException e) {
            throw new ApiException(0, "network", "Connection interrupted");
        } finally {
            activeStream = null;
            if (c != null) c.disconnect();
        }
    }

    public void cancelStream() {
        HttpURLConnection c = activeStream;
        if (c != null) c.disconnect();
    }

    private static void dispatch(String event, String data, StreamHandler h) {
        try {
            JSONObject j = new JSONObject(data);
            if ("route".equals(event)) h.onRoute(j);
            else if ("delta".equals(event)) h.onDelta(j.optString("text"));
            else if ("done".equals(event)) h.onDone(j);
            else if ("error".equals(event)) h.onError(j.optString("code"), j.optString("message"));
        } catch (JSONException ignored) { /* malformed event */ }
    }
}
