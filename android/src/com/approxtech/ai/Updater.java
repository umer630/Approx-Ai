package com.approxtech.ai;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * Settings → About & updates. Reads the same release information as web and Windows (/api/releases/latest), and
 * installs a newer Approx.apk only after: its SHA-256 matches the release manifest, its package id is this app's,
 * its versionCode is higher, and it is signed with the same key as the installed app. Android then shows its own
 * install confirmation — the app never claims a silent update.
 */
final class Updater {
    private final MainActivity a;
    Updater(MainActivity a) { this.a = a; }

    static long installedVersionCode(MainActivity a) {
        try {
            PackageInfo p = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) { return 0; }
    }

    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }

    /** SHA-256 of the signing certificate(s) of an installed package or an APK file (null if unknown). */
    @SuppressWarnings("deprecation")
    static String signerSha(MainActivity a, String apkPath) {
        try {
            PackageManager pm = a.getPackageManager();
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo p = apkPath == null ? pm.getPackageInfo(a.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES)
                        : pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES);
                if (p != null && p.signingInfo != null) sigs = p.signingInfo.getApkContentsSigners();
            } else {
                PackageInfo p = apkPath == null ? pm.getPackageInfo(a.getPackageName(), PackageManager.GET_SIGNATURES)
                        : pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNATURES);
                if (p != null) sigs = p.signatures;
            }
            if (sigs == null || sigs.length == 0) return null;
            return hex(MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray()));
        } catch (Exception e) { return null; }
    }

    void screen() {
        final LinearLayout col = a.settingsPage("About & updates");
        final long vc = installedVersionCode(a);
        a.add(col, a.text("Approx " + a.appVersion() + " (versionCode " + vc + ", build " + BuildInfo.BUILD_ID + ")", 15, MainActivity.TEXT, true), 12);
        a.add(col, a.text("Server: " + a.api.getBase(), 13, MainActivity.MUTED, false), 4);
        final TextView status = a.text("Checking for updates…", 14, MainActivity.TEXT, false);
        a.add(col, status, 16);
        final LinearLayout actions = a.vbox();
        a.add(col, actions, 8);
        a.add(col, a.button("Check for updates", false, new Runnable() { public void run() { screen(); } }), 16);
        a.add(col, a.link("Help & feedback", new Runnable() { public void run() { a.helpFeedback(); } }), 12);
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/releases/latest?version_code=" + vc); } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONObject rel = (JSONObject) r;
            String checked = "Last checked " + new java.text.SimpleDateFormat("d MMM, HH:mm", java.util.Locale.getDefault()).format(new java.util.Date());
            if (!rel.optBoolean("available")) { status.setText(rel.optString("reason", "No published release yet.") + "\n" + checked); return; }
            final JSONObject apk = rel.optJSONObject("android");
            boolean newer = rel.optLong("version_code") > vc;
            status.setText("Latest release: " + rel.optString("version") + " (versionCode " + rel.optLong("version_code") + ")\n"
                    + (newer ? (rel.optBoolean("mandatory") ? "Update required" : "Update available") : "You have the latest version") + "\n" + checked
                    + (rel.optString("notes").isEmpty() ? "" : "\n\nWhat's new:\n" + rel.optString("notes")));
            if (newer && apk != null) actions.addView(a.button("Update now", true, new Runnable() { public void run() { update(rel, apk); } }));
        } });
    }

    private void update(final JSONObject rel, final JSONObject apk) {
        final String want = apk.optString("sha256");
        final String releaseSigner = apk.optString("signer_sha256").replace(":", "").toLowerCase(java.util.Locale.ROOT);
        final String mine = signerSha(a, null);
        if (want.length() != 64) { a.toast("This release has no published checksum — not installing it."); return; }
        if (!releaseSigner.isEmpty() && mine != null && !releaseSigner.equals(mine)) {
            new AlertDialog.Builder(a).setTitle("Can't update in place")
                .setMessage("This copy of Approx was signed with a different key than the official release, so Android will refuse to update it.\n\n"
                    + "Back up anything you need, uninstall this Approx, then install Approx.apk from the official download link. Your account and chats are on the server and come back when you sign in.")
                .setPositiveButton("Open download page", new android.content.DialogInterface.OnClickListener() { public void onClick(android.content.DialogInterface d, int w) {
                    a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apk.optString("url")))); } })
                .setNegativeButton("Later", null).show();
            return;
        }
        a.toast("Downloading Approx " + rel.optString("version") + "…");
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return download(apk.optString("url"), want, rel.optLong("version_code")); } }, new MainActivity.Done() { public void ok(Object r) {
            install((File) r);
        } });
    }

    /** Download to cache/updates, verify checksum + package + versionCode + signer; deletes the file on any failure. */
    private File download(String url, String sha256, long versionCode) throws Exception {
        File dir = new File(a.getCacheDir(), "updates");
        dir.mkdirs();
        File[] old = dir.listFiles(); if (old != null) for (File f : old) f.delete();
        File part = new File(dir, "Approx.apk.part");
        File out = new File(dir, "Approx.apk");
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        HttpURLConnection c = null;
        try {
            String u = url;
            for (int hop = 0; hop < 5; hop++) {   // GitHub's stable link redirects to the release asset
                c = (HttpURLConnection) new URL(u).openConnection();
                c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(60000);
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { u = new URL(new URL(u), c.getHeaderField("Location")).toString(); c.disconnect(); continue; }
                if (code != 200) throw new Api.ApiException(code, "download_failed", "Download failed (HTTP " + code + ")");
                break;
            }
            InputStream in = c.getInputStream();
            FileOutputStream fo = new FileOutputStream(part);
            byte[] buf = new byte[65536]; int n;
            try { while ((n = in.read(buf)) > 0) { md.update(buf, 0, n); fo.write(buf, 0, n); } } finally { fo.close(); in.close(); }
        } catch (Exception e) { part.delete(); throw e; } finally { if (c != null) c.disconnect(); }
        String got = hex(md.digest());
        if (!got.equals(sha256)) { part.delete(); throw new Api.ApiException(0, "checksum_mismatch", "The download did not match the published checksum and was deleted."); }
        if (!part.renameTo(out)) { part.delete(); throw new Api.ApiException(0, "io", "Could not save the update."); }
        PackageInfo p = a.getPackageManager().getPackageArchiveInfo(out.getPath(), 0);
        long pv = p == null ? 0 : (Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        if (p == null || !a.getPackageName().equals(p.packageName) || pv <= installedVersionCode(a) || pv != versionCode) {
            out.delete(); throw new Api.ApiException(0, "not_an_update", "The downloaded file is not a newer Approx for this device and was deleted.");
        }
        String s = signerSha(a, out.getPath()); String mine = signerSha(a, null);
        if (s != null && mine != null && !s.equals(mine)) { out.delete(); throw new Api.ApiException(0, "signer_mismatch", "The update is signed with a different key than this app and was deleted."); }
        return out;
    }

    private void install(File apk) {
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            a.toast("Allow Approx to install updates, then tap Update now again.");
            a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(Uri.parse("content://" + a.getPackageName() + ".updates/Approx.apk"), "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        a.startActivity(i);   // Android's installer asks the person to confirm; app data and the signed-in session are kept
    }
}
