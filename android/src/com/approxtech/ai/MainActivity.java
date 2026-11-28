package com.approxtech.ai;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Approx AI for Android — native UI (no WebView), real backend over HTTPS.
 * Screens: server setup, login, signup, email verification, password reset, chat (streaming),
 * model + Medium/High mode, Plus menu attachments, history, settings (account, security,
 * memory, privacy/training consent, model preferences, usage, projects, files, delete account).
 */
public class MainActivity extends Activity {
    // Brand palette
    // Green + white theme (matches web/styles.css): white surfaces, dark neutral text, Approx green accents.
    static final int BG = Color.parseColor("#FFFFFF");
    static final int SURFACE = Color.parseColor("#FFFFFF");
    static final int SURFACE2 = Color.parseColor("#F5F8F6");
    static final int SURFACE3 = Color.parseColor("#ECF2EE");
    static final int LINE = Color.parseColor("#E3E9E5");
    static final int LINE_STRONG = Color.parseColor("#CFD9D3");
    static final int TEXT = Color.parseColor("#13201A");
    static final int MUTED = Color.parseColor("#5D6D66");
    static final int GREEN = Color.parseColor("#0E9F55");
    static final int GREEN_TEXT = Color.parseColor("#0B8547");
    static final int GREEN_STRONG = Color.parseColor("#0A7A41");
    static final int GREEN_SOFT = Color.parseColor("#E9F7EF");
    static final int ON_GREEN = Color.WHITE;
    static final int TEAL = Color.parseColor("#0B8547");
    static final int NAVY = Color.parseColor("#0B1F4A");
    static final int DANGER = Color.parseColor("#C62F3E");
    static final int CODE_BG = Color.parseColor("#F6F8F7");
    static final int CODE_TEXT = Color.parseColor("#1D2A24");
    static final int REQ_PICK_FILE = 41;

    final Handler ui = new Handler(Looper.getMainLooper());
    final ExecutorService pool = Executors.newFixedThreadPool(3);
    private SecureStore store;
    Api api;
    private FrameLayout root;

    // session state
    JSONObject user;
    private JSONArray models = new JSONArray();
    String model = "auto";
    String mode = "medium";
    static final String[] MODES = {"low", "medium", "high"};
    String chatId = null;
    String projectId = null;
    final List<JSONObject> attachments = new ArrayList<>();
    boolean streaming = false;
    // Workspace of the open screen/conversation: null (plain chat) | "education" | "code" | "work" (API 1.8 sessions).
    String workspace = null;
    TextView titleView;
    boolean atHome = false;
    static final int REQ_PICK_EDU = 43;
    static final int REQ_PICK_SESSION_FILE = 44;
    /** Work / Code / Education sessions (API 1.9). */
    Workspaces ws;
    SettingsMore more;
    Hub hub;
    private TextView topAction;
    /** Settings → Appearance → Text size (applied to every text the app draws). */
    float textScale = 1f;
    LinearLayout currentPage;
    private String uploadSessionId = null;
    /** The password typed at sign-up, kept in memory only (never stored) until the code is confirmed. */
    private String pendingPassword = null;
    static final int EDU_MAX_BYTES = 4 * 1024 * 1024;   // the production server accepts uploads up to 4 MB

    // chat views
    LinearLayout messageList;
    ScrollView messageScroll;
    private TextView modelIndicator;
    private LinearLayout chipRow;
    private TextView sendBtn;
    private TextView micBtn;
    private EditText prompt;
    private android.speech.SpeechRecognizer recognizer;
    private boolean listening = false;
    static final int REQ_MIC = 71;
    private TextView usageNote;

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new SecureStore(this);
        ws = new Workspaces(this);
        more = new SettingsMore(this);
        Notifier.channels(this);
        startBackgroundChecks();
        hub = new Hub(this);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        // Every tappable view gets the same subtle press-down/release feedback, including views added later.
        root.getViewTreeObserver().addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
            public void onGlobalLayout() { installPressFeedback(root); }
        });
        // Production builds bake the backend URL (APPROX_SERVER_URL → default_server_url): fresh install → sign in.
        final String server = resolveServer();
        // Branded launch: Approx logo + "by Approx Technology" with a short fade/scale, then the session check
        // (saved session → chat, otherwise sign-in). Total ≈ 0.9 s; no artificial loading screen beyond that.
        showSplash();
        root.postDelayed(new Runnable() { public void run() {
            if (server.length() == 0) { showWelcome(); return; }
            api = new Api(server, store.getToken());
            if (api.getToken() == null) showLogin(); else loadSession();
            handleAuthIntent(getIntent());   // returning from Google sign-in in the browser
        } }, 900);
    }

    /** Launch screen: logo, product name and "by Approx Technology" on white, fading/scaling in. */
    void showSplash() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setBackgroundColor(BG);
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.logo_mark);
        iv.setContentDescription("Approx AI");
        col.addView(iv, new LinearLayout.LayoutParams(dp(96), dp(96)));
        TextView name = text("Approx AI", 24, Color.parseColor("#13201A"), true);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        col.addView(name, lp);
        TextView by = text("by Approx Technology", 13, MUTED, false);
        by.setGravity(Gravity.CENTER);
        col.addView(by);
        root.removeAllViews();
        root.addView(col, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        col.setAlpha(0f); col.setScaleX(0.92f); col.setScaleY(0.92f);
        col.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(450).start();
    }

    /** The backend URL baked at build time (empty in an unconfigured build). */
    String bakedServer() { String s = getString(R.string.default_server_url); return s == null ? "" : s.trim(); }

    /**
     * Server to use: a saved override (admins / self-host) only if it was saved under THIS build's baked URL;
     * otherwise the baked production URL. An override left over from a build with a different baked URL is
     * discarded together with its session token, so an update always connects to the new production backend.
     */
    String resolveServer() {
        String[] r = ServerConfig.resolve(bakedServer(), store.get("server", ""), store.get("server_for_build", ""));
        if ("1".equals(r[1])) { store.put("server", ""); store.setToken(null); }
        return r[0];
    }
    /** Persist a user-chosen server, remembering which baked URL it overrides. */
    void saveServer(String s) { store.put("server", s); store.put("server_for_build", bakedServer()); }

    @Override
    protected void onDestroy() { if (recognizer != null) recognizer.destroy(); pool.shutdownNow(); super.onDestroy(); }

    // ------------------------------------------------------------------ async helpers
    interface Job { Object run() throws Exception; }
    interface Done { void ok(Object r); }

    void bg(final Job job, final Done done) {
        // A network job started by a button tap shows a loading state on that button until it finishes.
        final TextView busy = lastPressed != null && android.os.SystemClock.uptimeMillis() - lastPressedAt < 400 ? lastPressed : null;
        lastPressed = null;
        final CharSequence label = busy == null ? null : busy.getText();
        if (busy != null) { busy.setEnabled(false); busy.setAlpha(0.75f); busy.setText("Please wait…"); }
        final Runnable restore = new Runnable() { public void run() { if (busy != null) { busy.setEnabled(true); busy.setAlpha(1f); busy.setText(label); } } };
        pool.execute(new Runnable() {
            public void run() {
                try {
                    final Object r = job.run();
                    ui.post(new Runnable() { public void run() { restore.run(); if (done != null) done.ok(r); } });
                } catch (final Exception e) {
                    ui.post(new Runnable() { public void run() { restore.run(); handleError(e); } });
                }
            }
        });
    }

    void handleError(Exception e) {
        if (e instanceof Api.ApiException) {
            Api.ApiException a = (Api.ApiException) e;
            if (a.status == 401 && user != null) { logoutLocal(); toast("Session expired. Please sign in again."); return; }
            toast(a.getMessage());
        } else {
            toast("Something went wrong. Please try again.");
        }
    }

    void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }

    // ------------------------------------------------------------------ view helpers
    int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    GradientDrawable bgShape(int color, float radiusDp, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) g.setStroke(dp(1), strokeColor);
        return g;
    }

    void setTextScale(String size) { textScale = "small".equals(size) ? 0.9f : "large".equals(size) ? 1.15f : 1f; }

    TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp * textScale);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        return t;
    }

    TextView button(String label, boolean primary, final Runnable onClick) {
        final TextView b = text(label, 15, primary ? ON_GREEN : TEXT, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(16), dp(13), dp(16), dp(13));
        if (primary) b.setBackground(pressable(bgShape(GREEN, 12, 0), bgShape(GREEN_STRONG, 12, 0)));
        else b.setBackground(pressable(bgShape(SURFACE, 12, LINE_STRONG), bgShape(SURFACE3, 12, LINE_STRONG)));
        b.setClickable(true);
        b.setFocusable(true);
        b.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            long t = android.os.SystemClock.uptimeMillis();
            if (!b.isEnabled() || t - lastClickAt < 450) return;   // ignore double taps / taps while busy
            lastClickAt = t;
            lastPressed = b; lastPressedAt = t;
            onClick.run();
        } });
        return b;
    }

    long lastClickAt;
    TextView lastPressed; long lastPressedAt;

    /** Background that switches to `pressed` while the finger is down (instant visual feedback). */
    android.graphics.drawable.StateListDrawable pressable(android.graphics.drawable.Drawable normal, android.graphics.drawable.Drawable pressed) {
        android.graphics.drawable.StateListDrawable s = new android.graphics.drawable.StateListDrawable();
        s.addState(new int[]{android.R.attr.state_pressed}, pressed);
        s.addState(new int[]{}, normal);
        s.setExitFadeDuration(120);
        return s;
    }

    /**
     * Subtle press-down / release animation for every tappable view, applied once per view as screens are built
     * (idle → pressed 0.96 → released → normal). Returns false so the click itself is never delayed.
     */
    void installPressFeedback(View v) {
        if (v.isClickable() && v.getTag(R.id.press_fx) == null && !(v instanceof EditText)) {
            v.setTag(R.id.press_fx, Boolean.TRUE);
            v.setOnTouchListener(new View.OnTouchListener() { public boolean onTouch(View x, android.view.MotionEvent e) {
                int a = e.getActionMasked();
                if (a == android.view.MotionEvent.ACTION_DOWN && x.isEnabled()) x.animate().scaleX(0.96f).scaleY(0.96f).alpha(0.92f).setDuration(70).start();
                else if (a == android.view.MotionEvent.ACTION_UP || a == android.view.MotionEvent.ACTION_CANCEL) x.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(140).setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
                return false;
            } });
        }
        if (v instanceof ViewGroup) { ViewGroup g = (ViewGroup) v; for (int i = 0; i < g.getChildCount(); i++) installPressFeedback(g.getChildAt(i)); }
    }

    EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(MUTED);
        e.setTextColor(TEXT);
        e.setTextSize(16);
        e.setInputType(type);
        e.setTypeface(Typeface.DEFAULT);   // password fields otherwise switch to a monospace font
        e.setBackground(pressableFocus(bgShape(SURFACE, 12, LINE_STRONG), bgShape(SURFACE, 12, GREEN)));
        e.setPadding(dp(14), dp(13), dp(14), dp(13));
        e.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        return e;
    }

    android.graphics.drawable.StateListDrawable pressableFocus(android.graphics.drawable.Drawable normal, android.graphics.drawable.Drawable focused) {
        android.graphics.drawable.StateListDrawable s = new android.graphics.drawable.StateListDrawable();
        s.addState(new int[]{android.R.attr.state_focused}, focused);
        s.addState(new int[]{}, normal);
        return s;
    }

    /** Password input + a Show/Hide toggle under it. */
    EditText addPassword(LinearLayout col, String hint, int topDp) {
        final EditText pw = input(hint, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, pw, topDp);
        final TextView toggle = text("Show password", 13, GREEN_TEXT, true);
        toggle.setPadding(dp(4), dp(8), dp(4), dp(2));
        toggle.setClickable(true);
        toggle.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            boolean hidden = (pw.getInputType() & InputType.TYPE_TEXT_VARIATION_PASSWORD) == InputType.TYPE_TEXT_VARIATION_PASSWORD;
            int sel = pw.getSelectionEnd();
            pw.setInputType(InputType.TYPE_CLASS_TEXT | (hidden ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD));
            pw.setTypeface(Typeface.DEFAULT);
            if (sel >= 0) pw.setSelection(Math.min(sel, pw.length()));
            toggle.setText(hidden ? "Hide password" : "Show password");
        } });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        col.addView(toggle, lp);
        return pw;
    }

    // ---------- accounts used on this device (email + name only; never tokens or passwords) ----------
    JSONArray recentAccounts() { try { return new JSONArray(store.get("recent_accounts", "[]")); } catch (Exception e) { return new JSONArray(); } }
    void rememberAccount(JSONObject u) {
        if (u == null) return;
        try {
            JSONArray out = new JSONArray(); out.put(new JSONObject().put("email", u.optString("email")).put("name", u.optString("display_name")));
            JSONArray old = recentAccounts();
            for (int i = 0; i < old.length() && out.length() < 4; i++) if (!old.getJSONObject(i).optString("email").equals(u.optString("email"))) out.put(old.getJSONObject(i));
            store.put("recent_accounts", out.toString());
        } catch (Exception ignored) { }
    }
    void forgetAccount(String email) {
        try { JSONArray old = recentAccounts(), out = new JSONArray(); for (int i = 0; i < old.length(); i++) if (!old.getJSONObject(i).optString("email").equals(email)) out.put(old.getJSONObject(i)); store.put("recent_accounts", out.toString()); } catch (Exception ignored) { }
    }

    // ---------- Continue with Google (Google's own account chooser in the browser → one-time code back to the app) ----------
    TextView orDivider() { TextView t = text("or", 13, MUTED, false); t.setGravity(Gravity.CENTER_HORIZONTAL); return t; }

    /** "Continue with Google" + "or": hidden until the server says Google sign-in is configured (no dead button). */
    View googleButton() {
        final LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL);
        final TextView g = button("G   Continue with Google", false, new Runnable() { public void run() { startGoogleSignIn(); } });
        g.setTextColor(TEXT);
        box.addView(g); TextView or = orDivider(); box.addView(or);
        ((LinearLayout.LayoutParams) or.getLayoutParams()).topMargin = dp(10);
        box.setVisibility(View.GONE);
        new Thread(new Runnable() { public void run() {
            boolean on = false;
            try { JSONObject gc = api.get("/api/auth/config").optJSONObject("google"); on = gc != null && gc.optBoolean("enabled"); } catch (Exception ignored) { }
            final boolean show = on;
            runOnUiThread(new Runnable() { public void run() { if (show) box.setVisibility(View.VISIBLE); } });
        } }).start();
        return box;
    }
    void startGoogleSignIn() {
        bg(new Job() { public Object run() throws Exception { return api.get("/api/auth/config"); } }, new Done() { public void ok(Object r) {
            JSONObject gc = ((JSONObject) r).optJSONObject("google");
            if (gc == null || !gc.optBoolean("enabled")) { toast("Google sign-in isn't set up on this server yet. Use email and password."); return; }
            java.security.SecureRandom rnd = new java.security.SecureRandom();
            byte[] v = new byte[32]; rnd.nextBytes(v); byte[] st = new byte[16]; rnd.nextBytes(st);
            int f = android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP;
            String verifier = android.util.Base64.encodeToString(v, f), state = android.util.Base64.encodeToString(st, f);
            String challenge;
            try { challenge = android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(verifier.getBytes("US-ASCII")), f); }
            catch (Exception e) { toast("Google sign-in is unavailable on this device."); return; }
            store.put("g_verifier", verifier); store.put("g_state", state);
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(api.getBase() + "/#/google-mobile?challenge=" + challenge + "&state=" + state)));
        } });
    }
    /** approxai://auth?code=…&state=… from the browser after Google sign-in. */
    /** Disable a button and count down; re-enable with its label afterwards. */
    void cooldown(final TextView b, final int secs, final String label) {
        final int[] left = { Math.max(1, secs) };
        b.setEnabled(false); b.setAlpha(0.6f);
        ui.post(new Runnable() { public void run() {
            if (left[0] <= 0) { b.setEnabled(true); b.setAlpha(1f); b.setText(label); return; }
            b.setText(label + " (" + left[0] + "s)"); left[0]--; ui.postDelayed(this, 1000);
        } });
    }

    void handleAuthIntent(Intent intent) {
        Uri d = intent == null ? null : intent.getData();
        // Back from the email-verification page in the phone browser: no token travels in this link; just sign in.
        if (d != null && "approxai".equals(d.getScheme()) && "auth".equals(d.getHost()) && "1".equals(d.getQueryParameter("verified"))) {
            intent.setData(null);
            toast("Email verified. Please sign in.");
            if (user == null) showLogin();
            return;
        }
        if (d == null || !"approxai".equals(d.getScheme()) || !"auth".equals(d.getHost())) return;
        String code = d.getQueryParameter("code"), state = d.getQueryParameter("state");
        final String verifier = store.get("g_verifier", "");
        boolean ok = code != null && state != null && state.equals(store.get("g_state", "")) && verifier.length() > 0;
        store.put("g_verifier", ""); store.put("g_state", "");
        intent.setData(null);
        if (!ok) { toast("That sign-in link isn't valid. Please try again."); return; }
        final JSONObject body = obj("code", code, "verifier", verifier);
        bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/handoff", body); } }, new Done() { public void ok(Object r) {
            String tok = ((JSONObject) r).optString("token");
            store.setToken(tok); api.setToken(tok); loadSession();
        } });
    }

    @Override
    protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (api != null) handleAuthIntent(intent); }

    LinearLayout vbox() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    LinearLayout hbox() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }

    void add(LinearLayout parent, View child, int topMarginDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topMarginDp);
        parent.addView(child, lp);
    }

    ImageView logo(int sizeDp) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.logo_mark);   // transparent mark: no dark tile on the white UI
        iv.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
        iv.setContentDescription("Approx AI logo");
        return iv;
    }

    /** A centred, scrollable form page (auth screens). */
    /** Which auth screen is showing ("login", "signup", "verify", "forgot", …; null outside auth) — for Back. */
    String authScreen = null;

    /** Branded band on top of every auth screen: navy→green gradient, softly drifting light orbs, logo + name. */
    View authBand() {
        FrameLayout band = new FrameLayout(this);
        band.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[] { Color.parseColor("#0B1F4A"), Color.parseColor("#0A3B4A"), Color.parseColor("#0B6A45") }));
        int[][] orbs = { { 0x5510B98A, 170, -40, -50 }, { 0x400AA6A6, 140, 230, 70 }, { 0x306FD34A, 110, 120, 110 } };
        for (int[] o : orbs) {
            View orb = new View(this);
            GradientDrawable g = new GradientDrawable(); g.setShape(GradientDrawable.OVAL);
            g.setGradientType(GradientDrawable.RADIAL_GRADIENT); g.setGradientRadius(dp(o[1]) / 2f); g.setColors(new int[] { o[0], 0x00000000 });
            orb.setBackground(g);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(o[1]), dp(o[1]));
            lp.leftMargin = dp(o[2]); lp.topMargin = dp(o[3]);
            band.addView(orb, lp);
            android.animation.ObjectAnimator a = android.animation.ObjectAnimator.ofFloat(orb, "translationX", 0f, dp(36));
            a.setDuration(7000 + o[1] * 20L); a.setRepeatCount(android.animation.ValueAnimator.INFINITE); a.setRepeatMode(android.animation.ValueAnimator.REVERSE); a.start();
        }
        LinearLayout brand = vbox(); brand.setGravity(Gravity.CENTER); brand.setPadding(dp(16), dp(36), dp(16), dp(30));
        brand.addView(logo(56));
        TextView n = text("Approx AI", 22, Color.WHITE, true); n.setGravity(Gravity.CENTER); brand.addView(n);
        TextView by = text("by Approx Technology", 12, Color.parseColor("#CCE9DD"), false); by.setGravity(Gravity.CENTER); brand.addView(by);
        band.addView(brand, new FrameLayout.LayoutParams(-1, -2));
        return band;
    }

    @Override
    public void onBackPressed() {
        // Android Back on Sign-up / Forgot / Verify returns to Sign-in instead of closing the app.
        if (user == null && authScreen != null && !"login".equals(authScreen) && !"welcome".equals(authScreen)) { showLogin(); return; }
        // Signed in: a workspace conversation goes back to its workspace, any other screen goes back to Home.
        if (user != null && authScreen == null && !atHome) {
            if (workspace != null && chatId != null) workspaceHome(workspace); else showHome();
            return;
        }
        super.onBackPressed();
    }

    LinearLayout formPage(String title, String subtitle) {
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout outer = vbox();
        outer.addView(authBand(), new LinearLayout.LayoutParams(-1, -2));
        LinearLayout col = vbox();
        col.setPadding(dp(24), dp(20), dp(24), dp(24));
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        outer.addView(col, new LinearLayout.LayoutParams(-1, -2));
        authScreen = title;
        TextView t = text(title, 24, TEXT, true);
        t.setGravity(Gravity.CENTER);
        add(col, t, 16);
        if (subtitle != null) { TextView s = text(subtitle, 14, MUTED, false); s.setGravity(Gravity.CENTER); add(col, s, 6); }
        sv.addView(outer);
        root.removeAllViews();
        root.addView(sv);
        return col;
    }

    TextView link(String label, final Runnable r) {
        TextView t = text(label, 14, TEAL, false);
        t.setPadding(dp(4), dp(14), dp(4), dp(4));
        t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } });
        return t;
    }

    static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (JSONException ignored) { }
        return o;
    }

    // ------------------------------------------------------------------ welcome (server + sign in / create account on one screen)
    void showWelcome() {
        // Production builds always carry the backend URL (build.sh refuses to build without one), so people are never
        // asked for a server. If a build somehow has none, say so plainly instead of asking for a URL.
        if (resolveServer().length() > 0) { api = new Api(resolveServer(), store.getToken()); showLogin(); return; }
        LinearLayout col = formPage("Approx AI", "This app build is not connected to a server.");
        authScreen = "welcome";
        add(col, text("Please install the official Approx AI app.", 14, MUTED, false), 16);
    }

    // ------------------------------------------------------------------ auth
    void showLogin() {
        LinearLayout col = formPage("Welcome back", "Sign in to Approx AI");
        authScreen = "login";
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        // "Choose an account": accounts used on this phone before (tap to continue, long-press to remove).
        final JSONArray recent = recentAccounts();
        final EditText[] pwRef = new EditText[1];
        if (recent.length() > 0) {
            add(col, text("Choose an account", 13, MUTED, false), 20);
            for (int i = 0; i < recent.length(); i++) {
                final JSONObject a = recent.optJSONObject(i); if (a == null) continue;
                final String em = a.optString("email"); final String nm = a.optString("name");
                final TextView row = text((nm.length() > 0 ? nm + "\n" : "") + em, 14, TEXT, false);
                row.setPadding(dp(14), dp(12), dp(14), dp(12));
                row.setBackground(pressable(bgShape(SURFACE, 14, LINE), bgShape(SURFACE3, 14, LINE)));
                row.setClickable(true);
                row.setContentDescription("Continue as " + em);
                row.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { email.setText(em); if (pwRef[0] != null) pwRef[0].requestFocus(); } });
                row.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { forgetAccount(em); ((ViewGroup) v.getParent()).removeView(v); toast("Removed from this phone"); return true; } });
                add(col, row, 6);
            }
        }
        add(col, googleButton(), 18);
        add(col, email, 10);
        final EditText pw = addPassword(col, "Password", 10);
        pwRef[0] = pw;
        add(col, button("Sign in", true, new Runnable() { public void run() {
            if (email.getText().toString().trim().length() == 0 || pw.getText().length() == 0) { toast("Enter your email and password."); return; }
            final JSONObject body = obj("email", email.getText().toString().trim(), "password", pw.getText().toString(), "client", "mobile");
            bg(new Job() { public Object run() throws Exception {
                try { return api.post("/api/auth/login", body); }
                catch (Api.ApiException e) {
                    if ("email_not_verified".equals(e.code)) return obj("unverified", e.getMessage());
                    if ("mfa_required".equals(e.code) || "mfa_invalid".equals(e.code)) return obj("mfa", e.getMessage());
                    throw e;
                }
            } }, new Done() { public void ok(Object r) {
                JSONObject o = (JSONObject) r;
                // Two-step verification: the password was right; ask for the authenticator code and sign in again.
                if (o.has("mfa")) { askMfaCode(body, o.optString("mfa")); return; }
                // Correct password but email not verified yet: go straight to the code screen for this address.
                if (o.has("unverified")) { toast(o.optString("unverified")); showVerify(body.optString("email")); return; }
                String tok = o.optString("token");
                store.setToken(tok);
                api.setToken(tok);
                loadSession();
            } });
        } }), 16);
        LinearLayout links = hbox();
        links.addView(link("Create account", new Runnable() { public void run() { showSignup(); } }));
        View sp = new View(this); links.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
        links.addView(link("Forgot password?", new Runnable() { public void run() { showForgot(); } }));
        add(col, links, 6);
        add(col, link("Have a verification code?", new Runnable() { public void run() { showVerify(email.getText().toString().trim()); } }), 0);
    }

    void askMfaCode(final JSONObject body, String message) {
        final EditText code = input("6-digit code", InputType.TYPE_CLASS_NUMBER);
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Two-step verification").setMessage(message).setView(code)
                .setPositiveButton("Sign in", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    try { body.put("mfa_code", code.getText().toString().trim()); } catch (JSONException ignored) { }
                    bg(new Job() { public Object run() throws Exception {
                        try { return api.post("/api/auth/login", body); }
                        catch (Api.ApiException e) { if ("mfa_invalid".equals(e.code) || "mfa_required".equals(e.code)) return obj("mfa", e.getMessage()); throw e; }
                    } }, new Done() { public void ok(Object r) {
                        JSONObject o = (JSONObject) r;
                        if (o.has("mfa")) { askMfaCode(body, o.optString("mfa")); return; }
                        String tok = o.optString("token");
                        store.setToken(tok); api.setToken(tok); loadSession();
                    } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void showSignup() {
        LinearLayout col = formPage("Create your account", "Approx AI by Approx Technology");
        final EditText name = input("Name (optional)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PERSON_NAME);
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        add(col, googleButton(), 20);
        add(col, name, 10); add(col, email, 10);
        final EditText pw = addPassword(col, "Password (10+ chars, letters & numbers)", 10);
        final EditText pw2 = addPassword(col, "Confirm password", 8);
        add(col, button("Create account", true, new Runnable() { public void run() {
            String p1 = pw.getText().toString();
            if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email.getText().toString().trim()).matches()) { toast("Enter a valid email address."); return; }
            if (p1.length() < 10 || !p1.matches(".*[A-Za-z].*") || !p1.matches(".*\\d.*")) { toast("Use at least 10 characters with letters and numbers."); return; }
            if (!p1.equals(pw2.getText().toString())) { toast("The passwords don't match."); return; }
            final JSONObject body = obj("email", email.getText().toString().trim(), "password", pw.getText().toString(), "display_name", name.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/signup", body); } }, new Done() { public void ok(Object r) {
                pendingPassword = body.optString("password");
                showVerify(body.optString("email"), ((JSONObject) r).optString("message", "Check your email for the verification code."));
            } });
        } }), 16);
        add(col, link("Already have an account? Sign in", new Runnable() { public void run() { showLogin(); } }), 6);
    }

    void showVerify() { showVerify(user != null ? user.optString("email") : ""); }

    /** Enter the code from the email. The code is verified together with the address it was sent to (Supabase email
     *  OTP); the link in the same email works too and returns here via "Open the Approx app". */
    void showVerify(String prefillEmail) { showVerify(prefillEmail, null); }

    /** @param notice the server's answer to sign-up, kept on screen (a toast disappears before it can be read). */
    void showVerify(String prefillEmail, String notice) {
        LinearLayout col = formPage("Verify your email", "Enter the code from your email, or open the link in it.");
        if (notice != null && notice.length() > 0) {
            TextView n = text("Sent to " + prefillEmail + ".\n" + notice + "\nIt can take a minute. Check Spam and Promotions too.", 13.5f, TEXT, false);
            n.setPadding(dp(14), dp(12), dp(14), dp(12));
            n.setBackground(bgShape(GREEN_SOFT, 12, LINE));
            add(col, n, 16);
        }
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        if (prefillEmail != null) email.setText(prefillEmail);
        add(col, email, 24);
        final EditText code = input("Verification code", InputType.TYPE_CLASS_NUMBER);
        add(col, code, 10);
        // The password is saved together with the code (API 1.9): Supabase keeps the FIRST password of an address that
        // was signed up twice without verifying, so the password the person knows is set once the code proves the inbox.
        final EditText pw = addPassword(col, "Password (the one you chose at sign-up)", 10);
        if (pendingPassword != null) pw.setText(pendingPassword);
        add(col, button("Verify and sign in", true, new Runnable() { public void run() {
            String p1 = pw.getText().toString();
            if (code.getText().toString().trim().length() < 6) { toast("Enter the code from your email."); return; }
            if (p1.length() < 10 || !p1.matches(".*[A-Za-z].*") || !p1.matches(".*\\d.*")) { toast("Enter your password: at least 10 characters with letters and numbers."); return; }
            final JSONObject body = obj("email", email.getText().toString().trim(), "token", code.getText().toString().trim(),
                    "password", p1, "sign_in", true, "client", "mobile");
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/verify-email", body); } }, new Done() { public void ok(Object r) {
                pendingPassword = null;
                toast("Email verified. You're signed in.");
                String tok = ((JSONObject) r).optString("token");
                if (tok.length() > 0) { store.setToken(tok); api.setToken(tok); loadSession(); }
                else if (user != null) { try { user.put("email_verified", true); } catch (JSONException ignored) { } showChat(null); }
                else showLogin();
            } });
        } }), 16);
        // Resend with a cooldown (60 s, or the server's exact wait on 429) so the app never triggers Supabase's limit.
        final TextView[] rb = new TextView[1];
        rb[0] = button("Resend code", false, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception {
                try { return api.post("/api/auth/resend-verification", body); }
                catch (Api.ApiException e) { if (e.status == 429) return obj("message", e.getMessage(), "cooldown", e.retryAfter > 0 ? e.retryAfter : 60); throw e; }
            } }, new Done() { public void ok(Object r) {
                JSONObject j = (JSONObject) r;
                toast(j.optString("message"));
                cooldown(rb[0], j.has("cooldown") ? j.optInt("cooldown") : j.optInt("resend_after_s", 60), "Resend code");
            } });
        } });
        add(col, rb[0], 8);
        // Right after sign-up the email service refuses another email to the same address for 60 s: wait it out visibly.
        if (notice != null) cooldown(rb[0], 60, "Resend code");
        add(col, link("Back", new Runnable() { public void run() { if (user != null) showChat(null); else showLogin(); } }), 6);
    }

    void showForgot() {
        LinearLayout col = formPage("Reset password", "We'll email you a reset code.");
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        add(col, email, 24);
        add(col, button("Send reset code", false, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/forgot-password", body); } }, new Done() { public void ok(Object r) { toast(((JSONObject) r).optString("message")); } });
        } }), 12);
        final EditText code = input("Reset code", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        final EditText pw = input("New password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, code, 28); add(col, pw, 10);
        add(col, button("Set new password", true, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim(), "token", code.getText().toString().trim(), "password", pw.getText().toString());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/reset-password", body); } }, new Done() { public void ok(Object r) { toast("Password updated. Please sign in."); showLogin(); } });
        } }), 12);
        add(col, link("Back to sign in", new Runnable() { public void run() { showLogin(); } }), 6);
    }

    void loadSession() {
        bg(new Job() { public Object run() throws Exception {
            JSONObject me;
            try { me = api.get("/api/auth/me"); }
            catch (Api.ApiException e) {
                // Restore failed before any screen was shown: never leave the user on the splash screen.
                if (e.status == 401) return "expired";
                if (e.status == 0) return "offline";
                throw e;
            }
            JSONObject u = me.optJSONObject("user");
            String st = u == null ? "approved" : u.optString("approval_status", "approved");
            if (!"approved".equals(st)) return new Object[]{ "status", u.optString("status_message", "Your account is not active.") };
            JSONObject m = api.get("/api/models");
            JSONObject s = api.get("/api/settings");
            return new JSONObject[]{me, m, s};
        } }, new Done() { public void ok(Object r) {
            if ("expired".equals(r)) { logoutLocal(); toast("Your session ended. Please sign in again."); return; }
            if ("offline".equals(r)) { showOffline(); return; }
            if (r instanceof Object[]) { store.setToken(null); api.setToken(null); showLogin(); toast((String) ((Object[]) r)[1]); return; }
            JSONObject[] a = (JSONObject[]) r;
            user = a[0].optJSONObject("user");
            rememberAccount(user);
            models = a[1].optJSONArray("models");
            JSONObject st = a[2].optJSONObject("settings");
            mode = st.optString("default_mode", "medium");
            setTextScale(st.optString("text_size", "medium"));
            // Settings → Appearance → Start screen.
            String start = st.optString("default_workspace", "home");
            if ("work".equals(start) || "code".equals(start) || "education".equals(start)) workspaceHome(start); else showChat(null);
        } });
    }

    /** Startup without a connection: keep the saved session and offer a retry (never stuck on the splash). */
    void showOffline() {
        LinearLayout col = formPage("You're offline", "Approx AI couldn't reach the server. Your session is kept.");
        authScreen = "welcome";   // Back exits instead of going to sign-in (the saved session is still valid)
        add(col, button("Try again", true, new Runnable() { public void run() { showSplash(); loadSession(); } }), 24);
    }

    void logoutLocal() {
        store.setToken(null);
        if (api != null) api.setToken(null);
        user = null;
        chatId = null;
        showLogin();
    }

    String modelName(String id) {
        if ("auto".equals(id)) return "Auto";
        for (int i = 0; i < models.length(); i++) { JSONObject m = models.optJSONObject(i); if (id.equals(m.optString("id"))) return m.optString("name"); }
        return id;
    }

    // ------------------------------------------------------------------ app shell: top bar (☰ menu · title · new) + body
    // No bottom tab bar: History, Education, workspaces, Account and Settings live in the side menu (☰).
    LinearLayout shell(View body, boolean withComposer) {
        atHome = false;
        LinearLayout page = vbox();
        LinearLayout top = hbox();
        top.setPadding(dp(4), dp(6), dp(6), dp(6));
        top.setBackgroundColor(BG);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView menu = iconButton("☰", "Menu");
        menu.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { openDrawer(); } });
        top.addView(menu);
        titleView = text(workspace == null ? "Approx AI" : workspaceTitle(workspace), 17, TEXT, true);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, -2, 1); tlp.leftMargin = dp(2);
        top.addView(titleView, tlp);
        modelIndicator = text(modelName(model) + " · " + cap(mode), 12.5f, TEXT, false);
        modelIndicator.setPadding(dp(10), dp(6), dp(10), dp(6));
        modelIndicator.setBackground(pressable(bgShape(SURFACE, 999, LINE), bgShape(SURFACE3, 999, LINE)));
        modelIndicator.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { pickModel(); } });
        if (withComposer) top.addView(modelIndicator);
        if (withComposer && chatId != null) {
            TextView dots = iconButton("⋮", "Conversation options");
            dots.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { threeDotMenu(); } });
            top.addView(dots);
        }
        TextView fresh = iconButton("✎", workspace == null ? "New chat" : "New session");
        fresh.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (workspace == null) showHome(); else workspaceHome(workspace); } });
        top.addView(fresh);
        topAction = fresh;
        page.addView(top);
        View div = new View(this); div.setBackgroundColor(LINE); page.addView(div, new LinearLayout.LayoutParams(-1, dp(1)));
        page.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
        if (withComposer) page.addView(composer());
        currentPage = page;
        root.removeAllViews();
        root.addView(page);
        return page;
    }

    FrameLayout root() { return root; }

    /** Menu destinations replace the top-right action (Code: session history; artifacts: actions; null = none). */
    void setTopAction(String glyph, String description, final Runnable action) {
        if (topAction == null) return;
        if (glyph == null) { topAction.setVisibility(View.GONE); return; }
        topAction.setVisibility(View.VISIBLE);
        topAction.setText(glyph);
        topAction.setContentDescription(description);
        topAction.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { action.run(); } });
    }

    TextView iconButton(String glyph, String description) {
        TextView t = text(glyph, 20, TEXT, false);
        t.setGravity(Gravity.CENTER);
        t.setContentDescription(description);
        t.setBackground(pressable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT), bgShape(SURFACE3, 999, Color.TRANSPARENT)));
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        return t;
    }

    static String cap(String s) { return s.substring(0, 1).toUpperCase() + s.substring(1); }

    static String workspaceTitle(String w) {
        return Workspaces.title(w);
    }

    /** Home: personalized greeting, the three primary actions and the chat input. Clears any previous session state. */
    void showHome() {
        workspace = null; chatId = null; projectId = null; attachments.clear();
        showChat(null);
    }

    // ------------------------------------------------------------------ side menu (☰)
    void openDrawer() {
        final android.app.Dialog d = new android.app.Dialog(this, android.R.style.Theme_Translucent_NoTitleBar);
        FrameLayout scrim = new FrameLayout(this);
        scrim.setBackgroundColor(0x66000000);
        scrim.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { d.dismiss(); } });
        final int width = Math.min(dp(320), (int) (getResources().getDisplayMetrics().widthPixels * 0.86f));
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(SURFACE);
        sv.setClickable(true);
        LinearLayout col = vbox();
        col.setPadding(dp(16), dp(18), dp(16), dp(20));
        sv.addView(col);
        LinearLayout head = hbox();
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(logo(30));
        head.addView(text("  Approx", 19, TEXT, true));
        col.addView(head);
        add(col, button("New chat", true, new Runnable() { public void run() { d.dismiss(); showHome(); } }), 16);
        // The menu is the central navigation: every major area is one tap from here.
        String[][] items = {{"🕘", "History"}, {"⌕", "Search conversations"}, {"◫", "Projects"}, {"</>", "Approx Code"}, {"▦", "Approx Work"}, {"📘", "Education"},
                {"✦", "Artifacts"}, {"⏱", "Scheduled tasks"}, {"☰", "Sessions"}, {"📄", "Files"}, {"🔗", "Connected tools"}, {"⚙", "Settings"}, {"?", "Help and support"}};
        final String[] targets = {"history", "search", "projects", "code", "work", "education", "artifacts", "scheduled", "sessions", "files", "connected", "settings", "help"};
        final TextView[] settingsLabel = new TextView[1];
        for (int i = 0; i < items.length; i++) {
            final String t = targets[i];
            View item = drawerItem(items[i][0], items[i][1], new Runnable() { public void run() {
                d.dismiss();
                if ("home".equals(t)) showHome();
                else if ("history".equals(t) || "search".equals(t)) showHistory();
                else if ("connected".equals(t)) connectedServices();
                else if ("help".equals(t)) helpFeedback();
                else if ("projects".equals(t)) ws.projectsScreen();
                else if ("code".equals(t)) hub.code();
                else if ("artifacts".equals(t)) hub.artifacts(null);
                else if ("scheduled".equals(t)) hub.scheduled();
                else if ("sessions".equals(t)) hub.history(null, "recent");
                else if ("files".equals(t)) fileSettings();
                else if ("settings".equals(t)) showSettings();
                else workspaceHome(t);
            } });
            if ("settings".equals(t)) settingsLabel[0] = (TextView) ((LinearLayout) item).getChildAt(1);
            add(col, item, i == 0 ? 12 : 0);
        }
        add(col, divider(), 10);
        add(col, text("Recents", 13, MUTED, true), 12);
        final LinearLayout recent = vbox();
        add(col, recent, 2);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(width, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.START);
        scrim.addView(sv, plp);
        d.setContentView(scrim);
        d.show();
        sv.setTranslationX(-width);
        sv.animate().translationX(0).setDuration(180).start();
        if (api != null && api.getToken() != null) {
            pool.execute(new Runnable() { public void run() {
                try {
                    final JSONArray rs = api.get("/api/recents").optJSONArray("recents");
                    final JSONObject nres = api.get("/api/notifications");
                    Notifier.syncUnread(MainActivity.this, nres, store);
                    final int unread = nres.optInt("unread");
                    ui.post(new Runnable() { public void run() {
                        if (unread > 0 && settingsLabel[0] != null) settingsLabel[0].setText("Settings · " + unread + " new");
                        if (rs == null || rs.length() == 0) { recent.addView(text("Nothing yet", 13.5f, MUTED, false)); return; }
                        for (int i = 0; i < rs.length(); i++) {
                            final JSONObject c = rs.optJSONObject(i);
                            final String type = c.optString("type");
                            String tag = "chat".equals(type) ? "Chat" : "co_approx".equals(type) ? "Approx Work" : "code".equals(type) ? "Code" : "education".equals(type) ? "Education" : "artifact".equals(type) ? "Artifact" : "Scheduled";
                            TextView t = text(c.optString("title") + "  ·  " + tag, 13.5f, TEXT, false);
                            t.setSingleLine(true);
                            t.setEllipsize(android.text.TextUtils.TruncateAt.END);
                            t.setPadding(dp(8), dp(8), dp(8), dp(8));
                            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                                d.dismiss();
                                if ("chat".equals(type)) { workspace = null; projectId = null; showChat(c.optString("id")); }
                                else if ("artifact".equals(type)) hub.openArtifact(c.optString("id"));
                                else if ("scheduled".equals(type)) hub.scheduled();
                                else ws.open(c.optString("id"), null);
                            } });
                            recent.addView(t);
                        }
                    } });
                } catch (Exception ignored) { }
            } });
        }
    }

    View drawerItem(String glyph, String label, final Runnable r) {
        LinearLayout row = hbox();
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(11), dp(8), dp(11));
        row.setBackground(pressable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT), bgShape(SURFACE3, 12, Color.TRANSPARENT)));
        TextView g = text(glyph, 15, GREEN_TEXT, true);
        g.setGravity(Gravity.CENTER);
        row.addView(g, new LinearLayout.LayoutParams(dp(28), -2));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2); lp.leftMargin = dp(8);
        row.addView(text(label, 15.5f, TEXT, false), lp);
        row.setContentDescription(label);
        row.setClickable(true);
        row.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } });
        return row;
    }

    View divider() { View v = new View(this); v.setBackgroundColor(LINE); v.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(1))); return v; }

    // ------------------------------------------------------------------ workspaces: Education · Approx Code · Approx Work
    /** Clean landing: one action (Start new session) and the person's recent sessions — no technical detail. */
    /** Workspace home (Approx Work / Code / Education): sessions, projects, tasks, files, outputs, connected apps. */
    void workspaceHome(final String purpose) { if ("code".equals(purpose)) hub.code(); else ws.home(purpose); }

    void openSession(final JSONObject se) {
        workspace = se.optString("purpose");
        projectId = se.optString("id");
        JSONObject c = se.optJSONObject("chat");
        if (c != null) { showChat(c.optString("id")); return; }
        newChatIn(se);
    }

    void startSession(final String purpose) {
        if ("education".equals(purpose)) {
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/pdf", "text/plain"});
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(Intent.createChooser(i, "Choose your study material (PDF)"), REQ_PICK_EDU);
            return;
        }
        createSession(purpose, null);
    }

    void createSession(final String purpose, final String fileId) {
        bg(new Job() { public Object run() throws Exception {
            JSONObject b = obj("purpose", purpose);
            if (fileId != null) b.put("file_id", fileId);
            return api.post("/api/sessions", b).optJSONObject("session");
        } }, new Done() { public void ok(Object r) { workspace = purpose; newChatIn((JSONObject) r); } });
    }

    /** A clean conversation inside a session: nothing from the previous session is carried over. */
    void newChatIn(final JSONObject se) {
        attachments.clear();
        bg(new Job() { public Object run() throws Exception {
            return api.post("/api/chats", obj("project_id", se.optString("id"), "title", se.optString("name"), "model", model, "mode", mode)).optJSONObject("chat");
        } }, new Done() { public void ok(Object r) {
            workspace = se.optString("purpose");
            projectId = se.optString("id");
            showChat(((JSONObject) r).optString("id"));
        } });
    }

    /** First screen of an empty session: what Approx can do with it, as one-tap prompts. */
    View sessionIntro() {
        LinearLayout w = vbox();
        w.setPadding(0, dp(20), 0, 0);
        String[] prompts;
        String lead;
        if ("education".equals(workspace)) {
            lead = "Your material is ready. Ask anything about it, or start with:";
            prompts = new String[]{"Teach me this chapter step by step, like a teacher", "Summarize these notes", "Make a test from this material with an answer key",
                    "Create 10 MCQs with answers", "Explain the most difficult topics simply", "Make a one-week study plan for this material"};
        } else if ("code".equals(workspace)) {
            lead = "New coding session. Describe what you want to build or paste your code.";
            prompts = new String[]{"Build a small REST API in Node.js", "Explain and fix this code", "Write unit tests for a function"};
        } else {
            lead = "New work session. What are we working on?";
            prompts = new String[]{"Draft a project plan", "Summarize a document", "Write a professional email"};
        }
        w.addView(text(lead, 15, MUTED, false));
        for (final String q : prompts) {
            TextView t = text(q, 14.5f, TEXT, false);
            t.setPadding(dp(14), dp(11), dp(14), dp(11));
            t.setBackground(pressable(bgShape(SURFACE, 14, LINE), bgShape(SURFACE3, 14, LINE)));
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (!streaming) { messageList.removeAllViews(); send(q); } } });
            add(w, t, 8);
        }
        return w;
    }

    // ------------------------------------------------------------------ chat
    void showChat(final String id) {
        authScreen = null;
        chatId = id;
        messageScroll = new ScrollView(this);
        messageList = vbox();
        messageList.setPadding(dp(14), dp(12), dp(14), dp(16));
        messageScroll.addView(messageList);
        if (id == null) { workspace = null; ws.session = null; }
        shell(messageScroll, true);
        atHome = id == null;
        if (id == null) {
            welcome();
        } else {
            bg(new Job() { public Object run() throws Exception { return api.get("/api/chats/" + id); } }, new Done() { public void ok(Object r) {
                JSONObject o = (JSONObject) r;
                projectId = o.optJSONObject("chat").optString("project_id", null);
                if ("null".equals(projectId)) projectId = null;
                JSONArray msgs = o.optJSONArray("messages");
                for (int i = 0; i < msgs.length(); i++) addMessage(msgs.optJSONObject(i));
                String sid = o.optJSONObject("chat").optString("session_id", "");
                if (sid.length() > 0 && !"null".equals(sid)) attachSession(sid, id, msgs.length() == 0);
                else if (projectId != null) loadWorkspace(projectId, msgs.length() == 0);
                scrollDown();
            } });
        }
        refreshUsage();
    }

    /** A thread of a Work / Code / Education session: the session bar (threads + tools) goes under the top bar. */
    void attachSession(final String sid, final String threadId, final boolean empty) {
        Job load = new Job() { public Object run() throws Exception {
            if (ws.session != null && sid.equals(ws.session.optString("id"))) return ws.session;
            return api.get("/api/work-sessions/" + sid).optJSONObject("session");
        } };
        bg(load, new Done() { public void ok(Object r) {
            if (!threadId.equals(chatId)) return;   // the person already moved on
            ws.session = (JSONObject) r;
            workspace = ws.session.optString("kind");
            if (titleView != null) titleView.setText(Workspaces.title(workspace));
            if (currentPage != null) currentPage.addView(ws.sessionBar(threadId), 2);
            if (empty && messageList.getChildCount() == 0) messageList.addView(sessionIntro());
        } });
    }

    /** Add a file to a session (its threads read it). */
    void pickForSession(String sid) {
        uploadSessionId = sid;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("*/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(Intent.createChooser(i, "Add a file to this session"), REQ_PICK_SESSION_FILE);
    }

    /** The open conversation belongs to a session: show its workspace name and, when empty, its starting prompts. */
    void loadWorkspace(final String pid, final boolean empty) {
        bg(new Job() { public Object run() throws Exception { return api.get("/api/projects/" + pid); } }, new Done() { public void ok(Object r) {
            JSONObject p = ((JSONObject) r).optJSONObject("project");
            String purpose = p == null ? "" : p.optString("purpose", "");
            if (!"education".equals(purpose) && !"code".equals(purpose) && !"work".equals(purpose)) return;
            workspace = purpose;
            if (titleView != null) titleView.setText(workspaceTitle(purpose) + " · " + p.optString("name").replaceFirst("^(Study|Code session|Work session) · ", ""));
            if (empty && messageList.getChildCount() == 0) messageList.addView(sessionIntro());
        } });
    }

    void welcome() {
        LinearLayout w = vbox();
        w.setGravity(Gravity.CENTER_HORIZONTAL);
        w.setPadding(dp(4), dp(36), dp(4), 0);
        w.addView(logo(52));
        boolean returning = "1".equals(store.get("seen", ""));
        store.put("seen", "1");
        String[] g = Greeting.of(user == null ? "" : user.optString("display_name"), user == null ? "" : user.optString("email"),
                java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY), returning, System.currentTimeMillis() / 86_400_000L);
        TextView h = text(g[0], 26, TEXT, true);
        h.setGravity(Gravity.CENTER);
        add(w, h, 14);
        TextView sub = text(g[1], 16, MUTED, false);
        sub.setGravity(Gravity.CENTER);
        add(w, sub, 4);
        // Three primary actions. A new chat is the input below; everything else is in the ☰ menu.
        add(w, actionCard("</>", "Approx Code", "Repositories, devices and code sessions", new Runnable() { public void run() { workspaceHome("code"); } }), 28);
        add(w, actionCard("▦", "Approx Work", "Give Approx a task; come back for the result", new Runnable() { public void run() { workspaceHome("work"); } }), 10);
        add(w, actionCard("📘", "Education", "Courses, study sessions, quizzes and progress", new Runnable() { public void run() { workspaceHome("education"); } }), 10);
        if (user != null && !user.optBoolean("email_verified")) {
            add(w, button("Verify your email to start chatting", false, new Runnable() { public void run() { showVerify(); } }), 18);
        }
        messageList.addView(w);
    }

    View actionCard(String glyph, String title, String subtitle, final Runnable r) {
        LinearLayout row = hbox();
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(14), dp(14), dp(14), dp(14));
        row.setBackground(pressable(bgShape(SURFACE, 18, LINE), bgShape(SURFACE3, 18, LINE)));
        TextView ic = text(glyph, 16, GREEN_TEXT, true);
        ic.setGravity(Gravity.CENTER);
        ic.setBackground(bgShape(GREEN_SOFT, 12, Color.TRANSPARENT));
        row.addView(ic, new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout tx = vbox();
        tx.addView(text(title, 16, TEXT, true));
        tx.addView(text(subtitle, 13, MUTED, false));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1); lp.leftMargin = dp(12);
        row.addView(tx, lp);
        row.addView(text("›", 22, MUTED, false));
        row.setContentDescription(title);
        row.setClickable(true);
        row.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } });
        row.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        return row;
    }

    void copyClip(String label, String s) {
        android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        cm.setPrimaryClip(android.content.ClipData.newPlainText(label, s));
        toast("Copied");
    }

    /** Assistant answer: prose (markdown) interleaved with code-block cards, each with its own Copy button. */
    View assistantBody(String content) {
        LinearLayout col = vbox();
        for (final Md.Segment seg : Md.segments(content)) {
            if (seg.code) {
                LinearLayout card = vbox();
                card.setBackground(bgShape(CODE_BG, 12, LINE));
                LinearLayout head = hbox();
                head.setPadding(dp(10), dp(6), dp(8), dp(2));
                head.addView(text(seg.lang != null && !seg.lang.isEmpty() ? seg.lang : "code", 11.5f, MUTED, false));
                View sp = new View(this); head.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
                final String codeText = seg.text.toString();
                TextView cp = text("⧉ Copy", 11.5f, GREEN, true);
                cp.setPadding(dp(8), dp(4), dp(8), dp(4));
                cp.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { copyClip("code", codeText); } });
                head.addView(cp);
                card.addView(head);
                android.widget.HorizontalScrollView hs = new android.widget.HorizontalScrollView(this);
                hs.setHorizontalScrollBarEnabled(false);
                TextView code = text(codeText, 13.5f, CODE_TEXT, false);
                code.setTypeface(android.graphics.Typeface.MONOSPACE);
                code.setTextIsSelectable(true);
                code.setPadding(dp(12), dp(6), dp(12), dp(12));
                hs.addView(code);
                card.addView(hs);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(6); lp.bottomMargin = dp(6);
                col.addView(card, lp);
            } else {
                TextView t = text("", 15.5f, TEXT, false);
                t.setTextIsSelectable(true);
                t.setLineSpacing(0, 1.25f);
                t.setText(seg.text);
                col.addView(t);
            }
        }
        return col;
    }

    void addMessage(JSONObject m) {
        boolean isUser = "user".equals(m.optString("role"));
        LinearLayout wrap = vbox();
        wrap.setGravity(isUser ? Gravity.END : Gravity.START);
        final String content = m.optString("content");
        final View body;
        if (isUser) {
            TextView t = text("", 15.5f, TEXT, false);
            t.setTextIsSelectable(true);
            t.setLineSpacing(0, 1.25f);
            t.setText(content);
            t.setPadding(dp(14), dp(10), dp(14), dp(10));
            t.setBackground(bgShape(GREEN_SOFT, 18, Color.parseColor("#D3EDDF")));
            body = t;
        } else {
            body = assistantBody(content);   // prose + per-code-block Copy cards (markdown, tables, lists)
        }
        JSONArray atts = m.optJSONArray("attachments");
        if (atts != null && atts.length() > 0) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < atts.length(); i++) sb.append("📎 ").append(atts.optJSONObject(i).optString("filename")).append("  ");
            wrap.addView(text(sb.toString(), 12.5f, MUTED, false));
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        wrap.addView(body, lp);
        LinearLayout meta = hbox();
        TextView copy = text("Copy", 12, MUTED, false);
        copy.setPadding(0, dp(4), dp(14), dp(4));
        copy.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText("Approx AI", content));
            toast("Copied");
        } });
        meta.addView(copy);
        if (!isUser) {
            TextView regen = text("Regenerate", 12, MUTED, false);
            regen.setPadding(0, dp(4), dp(14), dp(4));
            regen.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { regenerate(); } });
            meta.addView(regen);
            final String mid = m.optString("id", "");
            if (mid.length() > 0 && chatId != null) {
                JSONObject fb = m.optJSONObject("feedback");
                final String rating = fb == null ? "" : fb.optString("rating", "");
                final TextView up = text("👍", 13, "up".equals(rating) ? GREEN_TEXT : MUTED, false);
                final TextView down = text("👎", 13, "down".equals(rating) ? GREEN_TEXT : MUTED, false);
                final TextView rep = text("Report", 12, fb != null && fb.optBoolean("reported") ? DANGER : MUTED, false);
                up.setContentDescription("Good response"); down.setContentDescription("Bad response"); rep.setContentDescription("Report response");
                for (TextView x : new TextView[]{up, down, rep}) { x.setPadding(0, dp(4), dp(14), dp(4)); x.setClickable(true); }
                up.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { sendFeedback(mid, obj("rating", "up"), up, down, rep); } });
                down.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { sendFeedback(mid, obj("rating", "down"), up, down, rep); } });
                rep.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                    final String[] keys = {"incorrect", "harmful", "unhelpful", "other"};
                    new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Report this response")
                        .setItems(new String[]{"Incorrect or misleading", "Harmful or unsafe", "Not helpful", "Something else"}, new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) { JSONObject b = obj("report", true, "reason", keys[w]); try { b.put("rating", "down"); } catch (Exception ignored) { } sendFeedback(mid, b, up, down, rep); toast("Report sent. Thank you."); }
                        }).show();
                } });
                meta.addView(up); meta.addView(down); meta.addView(rep);
            }
            if (m.has("model_id") && !m.isNull("model_id")) meta.addView(text(modelName(m.optString("model_id")) + " · " + cap(m.optString("mode", "medium")), 12, MUTED, false));
        }
        long t = m.optLong("created_at", 0);
        if (t > 0) { TextView ts = text("  " + DateUtils.getRelativeTimeSpanString(t), 12, MUTED, false); meta.addView(ts); }
        wrap.addView(meta);
        add(messageList, wrap, 14);
    }

    void sendFeedback(String mid, JSONObject body, final TextView up, final TextView down, final TextView rep) {
        final String cid = chatId; final JSONObject b = body;
        bg(new Job() { public Object run() throws Exception { return api.post("/api/chats/" + cid + "/messages/" + mid + "/feedback", b); } }, new Done() { public void ok(Object r) {
            JSONObject f = ((JSONObject) r).optJSONObject("feedback");
            String rt = f == null ? "" : f.optString("rating", "");
            up.setTextColor("up".equals(rt) ? GREEN_TEXT : MUTED); down.setTextColor("down".equals(rt) ? GREEN_TEXT : MUTED);
            rep.setTextColor(f != null && f.optBoolean("reported") ? DANGER : MUTED);
        } });
    }

    void scrollDown() { messageScroll.post(new Runnable() { public void run() { messageScroll.fullScroll(View.FOCUS_DOWN); } }); }

    View composer() {
        LinearLayout box = vbox();
        box.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout inner = vbox();
        inner.setBackground(bgShape(SURFACE, 22, LINE));
        inner.setPadding(dp(8), dp(6), dp(8), dp(8));
        chipRow = hbox();
        inner.addView(chipRow);
        renderChips();
        prompt = new EditText(this);
        prompt.setHint("Type or hold to talk");
        prompt.setHintTextColor(MUTED);
        prompt.setTextColor(TEXT);
        prompt.setTextSize(16);
        prompt.setBackground(null);
        prompt.setMaxLines(6);
        prompt.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        prompt.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        inner.addView(prompt);
        LinearLayout bar = hbox();
        TextView plus = round("+", false);
        plus.setContentDescription("Add attachments and tools");
        plus.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { plusMenu(); } });
        bar.addView(plus);
        TextView modelChip = text(modelName(model) + " ▾", 13, TEXT, true);
        modelChip.setPadding(dp(10), dp(7), dp(10), dp(7));
        modelChip.setBackground(bgShape(SURFACE2, 999, LINE));
        modelChip.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { pickModel(); } });
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(-2, -2); mlp.leftMargin = dp(6);
        // Model and mode are chosen from the top-bar pill; the composer stays clean.
        LinearLayout toggle = hbox();
        toggle.setBackground(bgShape(SURFACE2, 999, LINE));
        final TextView[] modeBtns = new TextView[MODES.length];
        for (int i = 0; i < MODES.length; i++) {
            final String mId = MODES[i];
            final TextView t = text(cap(mId), 13, TEXT, false);
            modeBtns[i] = t;
            t.setPadding(dp(10), dp(7), dp(10), dp(7));
            t.setContentDescription(cap(mId) + " efficiency mode");
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                mode = mId;
                styleModes(modeBtns);
                modelIndicator.setText(modelName(model) + " · " + cap(mode));
            } });
            toggle.addView(t);
        }
        styleModes(modeBtns);
        View sp = new View(this); bar.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
        micBtn = round("🎤", false);
        micBtn.setContentDescription("Voice input");
        micBtn.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { onMic(); } });
        // Hold to talk: press and hold the mic, release to stop (a short tap still toggles dictation).
        micBtn.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { if (!listening) onMic(); return true; } });
        micBtn.setOnTouchListener(new View.OnTouchListener() { public boolean onTouch(View v, android.view.MotionEvent e) {
            if (e.getAction() == android.view.MotionEvent.ACTION_UP && e.getEventTime() - e.getDownTime() > 500 && listening) stopListening();
            return false;
        } });
        LinearLayout.LayoutParams miclp = new LinearLayout.LayoutParams(-2, -2); miclp.rightMargin = dp(8);
        bar.addView(micBtn, miclp);
        sendBtn = round("➤", true);
        sendBtn.setContentDescription("Send");
        sendBtn.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            if (streaming) { api.cancelStream(); return; }
            String s = prompt.getText().toString().trim();
            if (s.length() == 0) return;
            prompt.setText("");
            send(s);
        } });
        bar.addView(sendBtn);
        inner.addView(bar);
        box.addView(inner);
        usageNote = text("", 11.5f, MUTED, false);
        usageNote.setGravity(Gravity.CENTER);
        add(box, usageNote, 4);
        return box;
    }

    // ------------------------------------------------------------------ voice input (device speech → text)
    void onMic() {
        if (listening) { stopListening(); return; }
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
            toast("No speech recognizer is available on this device. You can still type your message.");
            return;
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        startListening();
    }

    SecureStore store() { return store; }

    /** While Approx runs: new notifications → system notifications (if switched on), and a daily update check. */
    void startBackgroundChecks() {
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() { public void run() {
            if (api != null && api.getToken() != null) pool.execute(new Runnable() { public void run() {
                try { Notifier.syncUnread(MainActivity.this, api.get("/api/notifications"), store); } catch (Exception ignored) { }
                try {
                    long day = System.currentTimeMillis() / 86_400_000L;
                    if (!String.valueOf(day).equals(store.get("update_checked_day", ""))) {
                        store.put("update_checked_day", String.valueOf(day));
                        JSONObject rel = api.get("/api/releases/latest?version_code=" + Updater.installedVersionCode(MainActivity.this));
                        if (rel.optBoolean("update_available")) Notifier.show(MainActivity.this, Notifier.CH_UPDATES, 4242, "Approx " + rel.optString("version") + " is available",
                                "Open Settings → About & updates to install it.", "#/settings/about");
                    }
                } catch (Exception ignored) { }
            } });
            ui.postDelayed(tick[0], 60_000);
        } };
        ui.postDelayed(tick[0], 15_000);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == Notifier.REQ_NOTIFY) {
            boolean ok = Notifier.systemEnabled(this);
            store.put("phone_notifications", ok ? "1" : "");
            toast(ok ? "Phone notifications are on" : "Android did not allow notifications for Approx. You can allow them in Android Settings → Apps → Approx.");
            if (more != null) more.notifications();
            return;
        }
        if (req == REQ_MIC) {
            if (res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) startListening();
            else toast("Microphone permission is needed for voice. You can still type.");
        }
    }

    void startListening() {
        if (prompt == null) return;
        if (recognizer == null) {
            recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new android.speech.RecognitionListener() {
                public void onReadyForSpeech(Bundle p) { }
                public void onBeginningOfSpeech() { }
                public void onRmsChanged(float v) { }
                public void onBufferReceived(byte[] b) { }
                public void onEndOfSpeech() { }
                public void onError(int error) { listening = false; setMicActive(false);
                    if (error == android.speech.SpeechRecognizer.ERROR_NO_MATCH || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT) toast("Didn't catch that — try again.");
                    else if (error == android.speech.SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) toast("Microphone permission is required.");
                }
                public void onResults(Bundle results) {
                    listening = false; setMicActive(false);
                    java.util.ArrayList<String> l = results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                    if (l != null && !l.isEmpty()) { String cur = prompt.getText().toString(); prompt.setText((cur.isEmpty() ? "" : cur + " ") + l.get(0)); prompt.setSelection(prompt.getText().length()); }
                }
                public void onPartialResults(Bundle p) { }
                public void onEvent(int t, Bundle p) { }
            });
        }
        Intent i = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, java.util.Locale.getDefault());
        if (android.os.Build.VERSION.SDK_INT >= 23) i.putExtra(android.speech.RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        listening = true; setMicActive(true);
        try { recognizer.startListening(i); } catch (Exception e) { listening = false; setMicActive(false); toast("Could not start voice input."); }
    }

    void stopListening() { listening = false; setMicActive(false); if (recognizer != null) recognizer.stopListening(); }

    void setMicActive(boolean on) {
        ui.post(new Runnable() { public void run() { if (micBtn != null) { micBtn.setText(on ? "⏺" : "🎤"); micBtn.setContentDescription(on ? "Stop listening" : "Voice input"); } } });
    }

    void styleModes(TextView[] btns) {
        for (int i = 0; i < btns.length; i++) {
            boolean on = MODES[i].equals(mode);
            btns[i].setBackground(on ? bgShape(SURFACE, 999, GREEN) : null);
            btns[i].setTextColor(on ? GREEN_TEXT : MUTED);
        }
    }

    TextView round(String glyph, boolean primary) {
        TextView t = text(glyph, 18, primary ? ON_GREEN : TEXT, true);
        t.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable(); g.setShape(GradientDrawable.OVAL);
        GradientDrawable gp = new GradientDrawable(); gp.setShape(GradientDrawable.OVAL);
        if (primary) { g.setColor(GREEN); gp.setColor(GREEN_STRONG); }
        else { g.setColor(SURFACE); g.setStroke(dp(1), LINE); gp.setColor(SURFACE3); gp.setStroke(dp(1), LINE); }
        t.setBackground(pressable(g, gp));
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        return t;
    }

    void renderChips() {
        if (chipRow == null) return;
        chipRow.removeAllViews();
        for (final JSONObject a : attachments) {
            TextView c = text("📎 " + a.optString("filename") + "  ✕", 12.5f, TEXT, false);
            c.setPadding(dp(10), dp(5), dp(10), dp(5));
            c.setBackground(bgShape(SURFACE2, 10, LINE));
            c.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { attachments.remove(a); renderChips(); } });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2); lp.rightMargin = dp(6);
            chipRow.addView(c, lp);
        }
    }

    void refreshUsage() {
        bg(new Job() { public Object run() throws Exception { return api.get("/api/usage"); } }, new Done() { public void ok(Object r) { showUsage((JSONObject) r); } });
    }

    void showUsage(JSONObject u) {
        if (usageNote == null || u == null) return;
        JSONObject w = u.optJSONObject("window");
        if (w != null) usageNote.setText(w.optInt("remaining") + "/" + w.optInt("limit") + " requests left this hour · Approx AI can make mistakes.");
    }

    void setStreaming(boolean on) {
        streaming = on;
        if (sendBtn != null) { sendBtn.setText(on ? "■" : "➤"); sendBtn.setContentDescription(on ? "Stop" : "Send"); }
    }

    void send(final String text) {
        if (chatId == null) {
            final JSONObject body = obj("model", model, "mode", mode);
            if (projectId != null) { try { body.put("project_id", projectId); } catch (JSONException ignored) { } }
            bg(new Job() { public Object run() throws Exception { return api.post("/api/chats", body); } }, new Done() { public void ok(Object r) {
                chatId = ((JSONObject) r).optJSONObject("chat").optString("id");
                messageList.removeAllViews();
                send(text);
            } });
            return;
        }
        JSONArray ids = new JSONArray();
        JSONArray attMeta = new JSONArray();
        for (JSONObject a : attachments) { ids.put(a.optString("id")); attMeta.put(a); }
        attachments.clear();
        renderChips();
        addMessage(obj("role", "user", "content", text, "attachments", attMeta, "created_at", System.currentTimeMillis()));
        runStream("/api/chats/" + chatId + "/messages", obj("content", text, "model", model, "mode", mode, "attachments", ids));
    }

    void regenerate() {
        if (chatId == null || streaming) return;
        final String id = chatId;
        runStream("/api/chats/" + id + "/regenerate", obj("model", model, "mode", mode));
        // reload after completion to drop the replaced turn from the list
    }

    void runStream(final String path, final JSONObject body) {
        final TextView live = text("…", 15.5f, TEXT, false);
        live.setLineSpacing(0, 1.25f);
        add(messageList, live, 14);
        scrollDown();
        setStreaming(true);
        final StringBuilder acc = new StringBuilder();
        final JSONObject[] route = new JSONObject[1];
        final boolean regen = path.endsWith("/regenerate");
        pool.execute(new Runnable() { public void run() {
            try {
                api.stream(path, body, new Api.StreamHandler() {
                    public void onRoute(JSONObject r) { route[0] = r; }
                    public void onDelta(final String t) {
                        acc.append(t);
                        final String snap = acc.toString();
                        ui.post(new Runnable() { public void run() { live.setText(Md.render(snap)); scrollDown(); } });
                    }
                    public void onDone(final JSONObject d) {
                        ui.post(new Runnable() { public void run() {
                            messageList.removeView(live);
                            if (regen) { showChat(chatId); return; }
                            addMessage(obj("role", "assistant", "content", acc.toString(), "model_id", route[0] == null ? null : route[0].optString("model_id"),
                                    "mode", route[0] == null ? mode : route[0].optString("mode"), "created_at", System.currentTimeMillis()));
                            JSONObject mem = d.optJSONObject("memory_saved");
                            if (mem != null) toast("Saved to memory: " + mem.optString("content"));
                            showUsage(d.optJSONObject("usage"));
                            scrollDown();
                        } });
                    }
                    public void onError(final String code, final String message) {
                        ui.post(new Runnable() { public void run() { live.setText(acc + "\n\n⚠ " + message); live.setTextColor(DANGER); } });
                    }
                });
            } catch (final Api.ApiException e) {
                ui.post(new Runnable() { public void run() {
                    live.setText((acc.length() > 0 ? acc + "\n\n" : "") + "⚠ " + (e.code != null && e.code.equals("network") && acc.length() > 0 ? "Stopped." : e.getMessage()));
                    live.setTextColor(DANGER);
                    if ("email_not_verified".equals(e.code)) showVerify();
                } });
            } finally {
                ui.post(new Runnable() { public void run() { setStreaming(false); } });
            }
        } });
    }

    // ------------------------------------------------------------------ model picker + plus menu
    void pickModel() {
        final List<String> ids = new ArrayList<>();
        final List<String> labels = new ArrayList<>();
        ids.add("auto"); labels.add("Master Router (Auto) — best permitted model");
        for (int i = 0; i < models.length(); i++) {
            JSONObject m = models.optJSONObject(i);
            if (!m.optBoolean("in_selector", true)) continue;   // server decides: Nick 4.8 only once live, Lala 3.5 until then
            // Availability comes from the backend (lifecycle): a model becomes selectable when it is ACTIVE, no app update needed.
            JSONObject lc = m.optJSONObject("lifecycle");
            // API 1.7: the server reports `selectable` (available && status "online"); older servers: lifecycle ACTIVE.
            boolean notActive = m.has("selectable") ? !m.optBoolean("selectable") : (lc != null && !"ACTIVE".equals(lc.optString("state")));
            String why = m.has("status") ? m.optString("status") : (lc != null ? lc.optString("label", lc.optString("state")) : "unavailable");
            if (!m.optBoolean("available")) { labels.add(m.optString("name") + " — locked (" + m.optString("tier") + ")"); ids.add(null); }
            else if (notActive) { labels.add(m.optString("name") + " — " + why); ids.add("#status:" + m.optString("name") + " is not available yet (" + why + ")."); }
            else { ids.add(m.optString("id")); labels.add(m.optString("name") + ("unavailable".equals(m.optString("backend")) ? " (backend offline)" : "")); }
        }
        for (String md : MODES) { ids.add("#mode:" + md); labels.add((md.equals(mode) ? "●  " : "○  ") + "Efficiency: " + cap(md)); }
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("Model and efficiency")
                .setItems(labels.toArray(new String[0]), new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int which) {
                    String id = ids.get(which);
                    if (id == null) { toast("Your account does not have access to this model."); return; }
                    if (id.startsWith("#status:")) { toast(id.substring(8)); return; }
                    if (id.startsWith("#mode:")) { mode = id.substring(6); if (modelIndicator != null) modelIndicator.setText(modelName(model) + " · " + cap(mode)); return; }
                    model = id;
                    if (chatId == null && messageList != null) showChat(null); else showChat(chatId);
                } }).show();
    }

    /** Share the conversation as Markdown through Android's share sheet (save to Files/Drive, email, messaging…). */
    void shareConversation(final String cid) {
        bg(new Job() { public Object run() throws Exception { return api.get("/api/chats/" + cid + "/export?format=json"); } }, new Done() { public void ok(Object r) {
            JSONObject o = (JSONObject) r;
            StringBuilder md = new StringBuilder("# ").append(o.optString("title", "Conversation")).append("\n\n");
            JSONArray ms = o.optJSONArray("messages");
            for (int i = 0; ms != null && i < ms.length(); i++) {
                JSONObject m = ms.optJSONObject(i);
                md.append("## ").append("user".equals(m.optString("role")) ? "You" : "Approx AI").append("\n\n").append(m.optString("content")).append("\n\n");
            }
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/markdown");
            send.putExtra(Intent.EXTRA_SUBJECT, o.optString("title", "Approx AI conversation") + ".md");
            send.putExtra(Intent.EXTRA_TEXT, md.toString());
            startActivity(Intent.createChooser(send, "Share or export conversation"));
        } });
    }

    void threeDotMenu() {
        final List<String> labels = new ArrayList<>();
        final List<Runnable> actions = new ArrayList<>();
        if (chatId != null) {
            final String cid = chatId;
            labels.add("Rename conversation"); actions.add(new Runnable() { public void run() {
                final EditText e = input("Title", InputType.TYPE_CLASS_TEXT);
                new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Rename conversation").setView(e)
                    .setPositiveButton("Save", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                        call("PATCH", "/api/chats/" + cid, obj("title", e.getText().toString().trim()), new Runnable() { public void run() { toast("Renamed"); } });
                    } }).setNegativeButton("Cancel", null).show();
            } });
            labels.add("Share or export conversation"); actions.add(new Runnable() { public void run() { shareConversation(cid); } });
            labels.add("Archive conversation"); actions.add(new Runnable() { public void run() {
                call("PATCH", "/api/chats/" + cid, obj("archived", true), new Runnable() { public void run() { toast("Archived"); chatId = null; showChat(null); } });
            } });
            labels.add("Delete conversation"); actions.add(new Runnable() { public void run() {
                confirm("Delete conversation?", "It moves to Trash in Chat history, where you can restore it.", new Runnable() { public void run() {
                    call("DELETE", "/api/chats/" + cid, null, new Runnable() { public void run() { toast("Moved to trash"); chatId = null; showChat(null); } });
                } });
            } });
        }
        if (labels.isEmpty()) return;
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("Conversation")
                .setItems(labels.toArray(new String[0]), new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) { actions.get(w).run(); } })
                .show();
    }

void helpFeedback() {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("Help & feedback")
                .setMessage("Approx AI " + appVersion() + " (build " + BuildInfo.BUILD_ID + ")\nServer: " + api.getBase()
                        + "\n\n• ☰ opens the menu: New chat, Education, Approx Code, Approx Work, History, Account and Settings.\n• ✎ starts a new chat (or a new session inside a workspace).\n• Tap the model name to switch models or efficiency mode.\n• Use + to attach files; tap the mic to dictate.\n\nFor support, contact your Approx AI administrator.")
                .setPositiveButton("OK", null)
                .setNeutralButton("Open web app", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) { openWeb("/"); } })
                .show();
    }

    void plusMenu() {
        final String[] items = {"Files", "Photo", "PDF", "Document", "Photo library", "Data (CSV/JSON)", "Research (web)"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("Add to message")
                .setItems(items, new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    switch (w) {
                        case 0: pick("*/*"); break;
                        case 1: case 4: pick("image/*"); break;
                        case 2: pick("application/pdf"); break;
                        case 3: pick("application/vnd.openxmlformats-officedocument.wordprocessingml.document"); break;
                        case 5: pick("text/*"); break;
                        default: openWeb("/#/research");
                    }
                } }).show();
    }

    void openWeb(String path) {
        toast("Opening in your browser.");
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(api.getBase() + path)));
    }

    String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    void pick(String mime) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType(mime);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(Intent.createChooser(i, "Choose a file"), REQ_PICK_FILE);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK_EDU && res == RESULT_OK && data != null && data.getData() != null) { uploadStudyMaterial(data.getData()); return; }
        if (req == REQ_PICK_SESSION_FILE && res == RESULT_OK && data != null && data.getData() != null && uploadSessionId != null) {
            final Uri u = data.getData();
            final String sid = uploadSessionId;
            String nm = "file";
            Cursor cu = getContentResolver().query(u, null, null, null, null);
            if (cu != null) { if (cu.moveToFirst()) { int i = cu.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) nm = cu.getString(i); } cu.close(); }
            final String fname = nm;
            toast("Adding " + fname + "…");
            bg(new Job() { public Object run() throws Exception { return api.upload(fname, readUri(u, EDU_MAX_BYTES), sid); } },
                    new Done() { public void ok(Object r) { toast(fname + " added to this session"); ws.refreshThen(new Runnable() { public void run() { } }); } });
            return;
        }
        if (req != REQ_PICK_FILE || res != RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        String name = "upload";
        Cursor c = getContentResolver().query(uri, null, null, null, null);
        if (c != null) { if (c.moveToFirst()) { int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) name = c.getString(i); } c.close(); }
        final String fname = name;
        toast("Uploading " + fname + "…");
        bg(new Job() { public Object run() throws Exception {
            InputStream in = getContentResolver().openInputStream(uri);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n; int total = 0;
            while ((n = in.read(buf)) > 0) { total += n; if (total > 10 * 1024 * 1024) { in.close(); throw new Api.ApiException(413, "too_large", "File is larger than 10 MB"); } out.write(buf, 0, n); }
            in.close();
            return api.upload(fname, out.toByteArray());
        } }, new Done() { public void ok(Object r) {
            attachments.add(((JSONObject) r).optJSONObject("file"));
            renderChips();
        } });
    }

    /** Education: upload the PDF, then open a new study session grounded in it. */
    void uploadStudyMaterial(final Uri uri) {
        String name = "material.pdf";
        Cursor c = getContentResolver().query(uri, null, null, null, null);
        if (c != null) { if (c.moveToFirst()) { int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) name = c.getString(i); } c.close(); }
        final String fname = name.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf") || name.toLowerCase(java.util.Locale.ROOT).endsWith(".txt") ? name : name + ".pdf";
        final android.app.ProgressDialog pd = android.app.ProgressDialog.show(this, null, "Reading " + fname + "…", true, false);
        pool.execute(new Runnable() { public void run() {
            try {
                InputStream in = getContentResolver().openInputStream(uri);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n, total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > EDU_MAX_BYTES) { in.close(); throw new Api.ApiException(413, "too_large", "This file is larger than 4 MB. Split the chapter or compress the PDF, then try again."); }
                    out.write(buf, 0, n);
                }
                in.close();
                final String fileId = api.upload(fname, out.toByteArray()).optJSONObject("file").optString("id");
                final JSONObject o = api.post("/api/work-sessions", obj("workspace", "education", "file_id", fileId, "model", model, "mode", mode));
                ui.post(new Runnable() { public void run() {
                    pd.dismiss();
                    ws.session = o.optJSONObject("session");
                    ws.openThread(o.optJSONObject("thread").optString("id"));
                } });
            } catch (final Exception e) {
                ui.post(new Runnable() { public void run() { pd.dismiss(); handleError(e); } });
            }
        } });
    }

    byte[] readUri(Uri uri, int max) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) { in.close(); throw new Api.ApiException(413, "too_large", "This file is larger than " + (max / 1024 / 1024) + " MB."); }
            out.write(buf, 0, n);
        }
        in.close();
        return out.toByteArray();
    }

    // ------------------------------------------------------------------ history
    void showHistory() {
        final LinearLayout col = vbox();
        col.setPadding(dp(14), dp(12), dp(14), dp(12));
        final EditText search = input("Search conversations", InputType.TYPE_CLASS_TEXT);
        col.addView(search);
        final String[] view = {"active"};
        LinearLayout tabs = hbox();
        final LinearLayout list = vbox();
        final Runnable load = new Runnable() { public void run() {
            final String q = search.getText().toString();
            final Runnable self = this;
            bg(new Job() { public Object run() throws Exception { return api.get("/api/chats?view=" + view[0] + "&q=" + Api.enc(q)); } }, new Done() { public void ok(Object r) {
                list.removeAllViews();
                JSONArray chats = ((JSONObject) r).optJSONArray("chats");
                if (chats.length() == 0) add(list, text("No conversations.", 14, MUTED, false), 12);
                for (int i = 0; i < chats.length(); i++) list.addView(historyRow(chats.optJSONObject(i), view[0], self));
            } });
        } };
        String[][] defs = {{"active", "Recent"}, {"archived", "Archived"}, {"trash", "Trash"}};
        for (final String[] d : defs) {
            TextView t = text(d[1], 13, TEXT, false);
            t.setPadding(dp(12), dp(7), dp(12), dp(7));
            t.setBackground(bgShape(SURFACE2, 999, LINE));
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { view[0] = d[0]; load.run(); } });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2); lp.rightMargin = dp(6);
            tabs.addView(t, lp);
        }
        add(col, tabs, 10);
        add(col, list, 6);
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            public void onTextChanged(CharSequence s, int a, int b, int c) { }
            public void afterTextChanged(Editable e) { ui.removeCallbacks(load); ui.postDelayed(load, 300); }
        });
        ScrollView sv = new ScrollView(this);
        sv.addView(col);
        shell(sv, false);
        load.run();
    }

    View historyRow(final JSONObject c, final String view, final Runnable reload) {
        LinearLayout row = vbox();
        row.setPadding(dp(6), dp(12), dp(6), dp(12));
        row.addView(text(c.optString("title"), 15, TEXT, true));
        row.addView(text(modelName(c.optString("model_id")) + " · " + cap(c.optString("mode")) + " · " + DateUtils.getRelativeTimeSpanString(c.optLong("updated_at")) + (c.optBoolean("is_fab") ? " · FAB" : ""), 12, MUTED, false));
        row.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (!"trash".equals(view)) { workspace = null; projectId = null; showChat(c.optString("id")); } } });
        row.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { historyActions(c, view, reload); return true; } });
        View div = new View(this); div.setBackgroundColor(LINE);
        LinearLayout wrap = vbox();
        wrap.addView(row);
        wrap.addView(div, new LinearLayout.LayoutParams(-1, dp(1)));
        return wrap;
    }

    void historyActions(final JSONObject c, final String view, final Runnable reload) {
        final String id = c.optString("id");
        final String[] items = "trash".equals(view) ? new String[]{"Restore", "Delete forever"} : new String[]{"Rename", "archived".equals(view) ? "Unarchive" : "Archive", "Move to trash"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(c.optString("title")).setItems(items, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface d, int w) {
                final String act = items[w];
                if ("Rename".equals(act)) {
                    final EditText e = input("Title", InputType.TYPE_CLASS_TEXT);
                    e.setText(c.optString("title"));
                    new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Rename").setView(e).setPositiveButton("Save", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d2, int x) { call("PATCH", "/api/chats/" + id, obj("title", e.getText().toString()), reload); }
                    }).setNegativeButton("Cancel", null).show();
                } else if ("Archive".equals(act) || "Unarchive".equals(act)) call("PATCH", "/api/chats/" + id, obj("archived", "Archive".equals(act)), reload);
                else if ("Move to trash".equals(act)) call("DELETE", "/api/chats/" + id, null, reload);
                else if ("Restore".equals(act)) call("PATCH", "/api/chats/" + id, obj("restore", true), reload);
                else confirm("Delete forever?", "This permanently deletes the conversation.", new Runnable() { public void run() { call("DELETE", "/api/chats/" + id + "?purge=1", null, reload); } });
            }
        }).show();
    }

    void call(final String method, final String path, final JSONObject body, final Runnable after) {
        bg(new Job() { public Object run() throws Exception { return api.request(method, path, body); } }, new Done() { public void ok(Object r) { if (after != null) after.run(); } });
    }

    void confirm(String title, String msg, final Runnable yes) {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(title).setMessage(msg)
                .setPositiveButton("Confirm", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) { yes.run(); } })
                .setNegativeButton("Cancel", null).show();
    }

    // ------------------------------------------------------------------ settings
    LinearLayout settingsPage(String title) {
        LinearLayout col = vbox();
        col.setPadding(dp(16), dp(12), dp(16), dp(24));
        if (!"Settings".equals(title)) col.addView(link("‹ All settings", new Runnable() { public void run() { showSettings(); } }));
        add(col, text(title, 20, TEXT, true), 6);
        ScrollView sv = new ScrollView(this);
        sv.addView(col);
        shell(sv, false);
        return col;
    }

    TextView row(String label, final Runnable r) {
        TextView t = text(label + "", 16, TEXT, false);
        t.setPadding(dp(4), dp(14), dp(4), dp(14));
        t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } });
        return t;
    }

    void showSettings() {
        LinearLayout col = settingsPage("Settings");
        add(col, text(user == null ? "" : user.optString("email") + " · plan " + user.optString("plan"), 13, MUTED, false), 4);
        Object[][] rows = {
                {"Account", new Runnable() { public void run() { accountSettings(); } }},
                {"Profile & language", new Runnable() { public void run() { more.languageAndStyle(); } }},
                {"Billing", new Runnable() { public void run() { infoPage("Billing", "Plan: " + (user == null ? "" : user.optString("plan")) + "\n\nFree: Nick 4.8 + Hike 6.5. Pro adds Sona 9.0. FAB is granted individually by Approx Technology.\n\nOnline payments are not enabled yet (no payment provider is connected); plan changes are applied by an administrator."); } }},
                {"Usage", new Runnable() { public void run() { usageSettings(); } }},
                {"Notifications", new Runnable() { public void run() { more.notifications(); } }},
                {"Preferences (text size, start screen)", new Runnable() { public void run() { more.appearance(); } }},
                {"AI preferences (models, efficiency)", new Runnable() { public void run() { modelSettings(); } }},
                {"Workspaces (Approx Work, Approx Code, Education)", new Runnable() { public void run() { more.workspaces(); } }},
                {"Security, two-step verification & sessions", new Runnable() { public void run() { securitySettings(); } }},
                {"Privacy & training consent", new Runnable() { public void run() { privacySettings(); } }},
                {"Data controls", new Runnable() { public void run() { more.dataControls(); } }},
                {"Connected services", new Runnable() { public void run() { connectedServices(); } }},
                {"Memory", new Runnable() { public void run() { memorySettings(); } }},
                {"Projects", new Runnable() { public void run() { projectSettings(); } }},
                {"API & developer console", new Runnable() { public void run() { openWeb("/developers/"); } }},
                {"About & updates", new Runnable() { public void run() { new Updater(MainActivity.this).screen(); } }},
                {"Help & support", new Runnable() { public void run() { helpFeedback(); } }},
                {"Delete account", new Runnable() { public void run() { deleteAccount(); } }},
                {"Log out", new Runnable() { public void run() {
                    // Revoke the server session in the background; the local session is cleared in every case.
                    final Api a = api;
                    pool.execute(new Runnable() { public void run() { try { a.post("/api/auth/logout", new JSONObject()); } catch (Exception ignored) { } } });
                    logoutLocal();
                } }},
        };
        for (Object[] r : rows) if (r[0] != null) add(col, row((String) r[0], (Runnable) r[1]), 0);   // null label = hidden for this role
        add(col, text("Approx AI 1.0.0 · Approx Technology · " + api.getBase(), 12, MUTED, false), 18);
    }

    /** Live status of Approx's own services (no fake "connected" states). */
    void connectedServices() {
        final LinearLayout col = settingsPage("Connected services");
        final TextView t = text("Checking…", 15, TEXT, false);
        add(col, t, 12);
        bg(new Job() { public Object run() throws Exception { return api.get("/api/integrations"); } }, new Done() { public void ok(Object r) {
            JSONObject s = (JSONObject) r;
            JSONObject lala = s.optJSONObject("lala"), claude = s.optJSONObject("claude"), dev = s.optJSONObject("devices"), sb = s.optJSONObject("supabase");
            StringBuilder b = new StringBuilder();
            b.append("Lala 3.5 (Ollama): ").append(lala != null && lala.optBoolean("ok") ? "online" : "offline — " + (lala == null ? "" : lala.optString("detail"))).append("\n\n");
            b.append("Claude (Anthropic): ").append(claude != null && claude.optBoolean("configured") ? "configured on the server" : "not configured (an administrator must add ANTHROPIC_API_KEY on the server)").append("\n\n");
            b.append("Your computers: ").append(dev == null ? 0 : dev.optInt("connected")).append(" connected (Approx Code → Add device)\n\n");
            if (sb != null) b.append("Supabase Auth (admin): ").append(sb.optString("detail")).append("\n\n");
            b.append("Third-party accounts (GitHub, Google Drive, Gmail, Calendar): not available yet — they need OAuth apps registered by Approx Technology.");
            t.setText(b.toString());
        } });
    }
    void infoPage(String title, String body) { add(settingsPage(title), text(body, 15, TEXT, false), 12); }

    Switch toggle(String label, boolean checked, final String key, final Runnable after) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextColor(TEXT);
        s.setTextSize(15);
        s.setChecked(checked);
        s.setPadding(0, dp(12), 0, dp(12));
        s.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() { public void onCheckedChanged(CompoundButton b, boolean v) {
            call("PATCH", "/api/settings", obj(key, v), after);
        } });
        return s;
    }

    void accountSettings() {
        final LinearLayout col = settingsPage("Account & profile");
        add(col, text(user.optString("email") + (user.optBoolean("email_verified") ? " (verified)" : " (not verified)"), 15, TEXT, false), 10);
        final EditText name = input("Display name", InputType.TYPE_CLASS_TEXT);
        name.setText(user.optString("display_name"));
        add(col, name, 12);
        add(col, button("Save", true, new Runnable() { public void run() {
            call("PATCH", "/api/settings", obj("display_name", name.getText().toString()), new Runnable() { public void run() {
                try { user.put("display_name", name.getText().toString()); } catch (JSONException ignored) { }
                toast("Saved");
            } });
        } }), 10);
        add(col, text("Change email", 16, TEXT, true), 22);
        final EditText ne = input("New email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        final EditText pw = input("Current password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, ne, 8); add(col, pw, 8);
        add(col, button("Send confirmation", false, new Runnable() { public void run() {
            call("POST", "/api/auth/change-email", obj("new_email", ne.getText().toString(), "password", pw.getText().toString()), new Runnable() { public void run() { toast("Check the new inbox to confirm."); } });
        } }), 8);
        if (!user.optBoolean("email_verified")) add(col, button("Verify email", false, new Runnable() { public void run() { showVerify(); } }), 12);
    }

    void securitySettings() {
        LinearLayout col = settingsPage("Security");
        final EditText cur = input("Current password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final EditText nw = input("New password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, cur, 12); add(col, nw, 8);
        add(col, button("Change password", true, new Runnable() { public void run() {
            call("POST", "/api/auth/change-password", obj("current_password", cur.getText().toString(), "new_password", nw.getText().toString()), new Runnable() { public void run() { toast("Password changed. Other sessions signed out."); } });
        } }), 10);
        add(col, button("Sign out all other sessions", false, new Runnable() { public void run() {
            call("POST", "/api/auth/sessions/revoke-others", new JSONObject(), new Runnable() { public void run() { toast("Done"); securitySettings(); } });
        } }), 16);
        more.security(col);
    }

    void memorySettings() {
        final LinearLayout col = settingsPage("Memory");
        bg(new Job() { public Object run() throws Exception { return api.get("/api/memory"); } }, new Done() { public void ok(Object r) {
            JSONObject o = (JSONObject) r;
            add(col, toggle("Memory enabled (never used by FAB)", o.optBoolean("enabled"), "memory_enabled", null), 8);
            final EditText add = input("Add a memory, e.g. I prefer Roman Urdu", InputType.TYPE_CLASS_TEXT);
            add(col, add, 8);
            add(col, button("Add", false, new Runnable() { public void run() { call("POST", "/api/memory", obj("content", add.getText().toString()), new Runnable() { public void run() { memorySettings(); } }); } }), 6);
            JSONArray mems = o.optJSONArray("memories");
            for (int i = 0; i < mems.length(); i++) {
                final JSONObject m = mems.optJSONObject(i);
                TextView t = row("• " + m.optString("content") + "   (tap to delete)", new Runnable() { public void run() {
                    confirm("Delete memory?", m.optString("content"), new Runnable() { public void run() { call("DELETE", "/api/memory/" + m.optString("id"), null, new Runnable() { public void run() { memorySettings(); } }); } });
                } });
                add(col, t, 0);
            }
            add(col, button("Clear all memory", false, new Runnable() { public void run() {
                confirm("Clear all memory?", "Every saved memory will be deleted.", new Runnable() { public void run() { call("DELETE", "/api/memory", null, new Runnable() { public void run() { memorySettings(); } }); } });
            } }), 16);
        } });
    }

    void privacySettings() {
        final LinearLayout col = settingsPage("Privacy & training consent");
        bg(new Job() { public Object run() throws Exception { return api.get("/api/settings"); } }, new Done() { public void ok(Object r) {
            JSONObject s = ((JSONObject) r).optJSONObject("settings");
            add(col, toggle("Help improve Nick, Hike & Sona", s.optBoolean("training_opt_in"), "training_opt_in", null), 8);
            add(col, text("Off by default. When on, conversations you mark eligible may be used for model adaptation after PII removal and quality/safety filtering. FAB conversations are never used. Turning this off removes all your chats from future training exports.", 13, MUTED, false), 4);
        } });
    }

    void modelSettings() {
        final LinearLayout col = settingsPage("Model preferences");
        for (int i = 0; i < models.length(); i++) {
            final JSONObject m = models.optJSONObject(i);
            add(col, text(m.optString("name") + (m.optBoolean("available") ? "" : "  (locked)"), 15, m.optBoolean("available") ? TEXT : MUTED, true), 12);
            add(col, text(m.optString("description"), 13, MUTED, false), 2);
            if (m.optBoolean("available")) add(col, link("Set as default", new Runnable() { public void run() { call("PATCH", "/api/settings", obj("default_model", m.optString("id")), new Runnable() { public void run() { toast("Default model saved"); } }); } }), 0);
        }
        add(col, text("Default efficiency mode", 15, TEXT, true), 18);
        add(col, text("Low = fast and concise · Medium = balanced · High = maximum effort. Separate from the model.", 12, MUTED, false), 2);
        for (final String md : MODES) {
            add(col, link(cap(md), new Runnable() { public void run() { call("PATCH", "/api/settings", obj("default_mode", md), new Runnable() { public void run() { mode = md; toast("Saved"); } }); } }), 0);
        }
    }

    void usageSettings() {
        final LinearLayout col = settingsPage("Usage & quota");
        bg(new Job() { public Object run() throws Exception { return api.get("/api/usage"); } }, new Done() { public void ok(Object r) {
            JSONObject u = (JSONObject) r;
            JSONObject w = u.optJSONObject("window");
            JSONObject c = u.optJSONObject("cycle");
            add(col, text("This hour: " + w.optInt("used") + " / " + w.optInt("limit") + " requests", 16, TEXT, true), 12);
            add(col, text("Usage cycle (" + c.optInt("days") + " days): " + c.optInt("used") + " requests · renews " + DateUtils.getRelativeTimeSpanString(c.optLong("renews_at")), 14, MUTED, false), 8);
            add(col, text("Quota is enforced by the Approx server.", 12, MUTED, false), 12);
        } });
    }

    void projectSettings() {
        final LinearLayout col = settingsPage("Projects");
        final EditText name = input("New project name", InputType.TYPE_CLASS_TEXT);
        final EditText instr = input("Instructions (optional)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        add(col, name, 10); add(col, instr, 8);
        add(col, button("Create project", true, new Runnable() { public void run() {
            call("POST", "/api/projects", obj("name", name.getText().toString(), "instructions", instr.getText().toString()), new Runnable() { public void run() { projectSettings(); } });
        } }), 8);
        bg(new Job() { public Object run() throws Exception { return api.get("/api/projects?kind=knowledge"); } }, new Done() { public void ok(Object r) {
            JSONArray ps = ((JSONObject) r).optJSONArray("projects");
            for (int i = 0; i < ps.length(); i++) {
                final JSONObject p = ps.optJSONObject(i);
                add(col, row("▸ " + p.optString("name") + "  · " + p.optInt("chat_count") + " chats · tap for new chat", new Runnable() { public void run() {
                    projectId = p.optString("id"); chatId = null; showChat(null); toast("New chat in " + p.optString("name"));
                } }), 0);
            }
        } });
    }

    void fileSettings() {
        final LinearLayout col = settingsPage("Files");
        bg(new Job() { public Object run() throws Exception { return api.get("/api/files"); } }, new Done() { public void ok(Object r) {
            JSONArray fs = ((JSONObject) r).optJSONArray("files");
            if (fs.length() == 0) add(col, text("No files uploaded.", 14, MUTED, false), 10);
            for (int i = 0; i < fs.length(); i++) {
                final JSONObject f = fs.optJSONObject(i);
                add(col, row(f.optString("filename") + "  · " + (f.optInt("size") / 1024) + " KB · " + f.optString("scan_status") + "  (tap to delete)", new Runnable() { public void run() {
                    confirm("Delete file?", f.optString("filename"), new Runnable() { public void run() { call("DELETE", "/api/files/" + f.optString("id"), null, new Runnable() { public void run() { fileSettings(); } }); } });
                } }), 0);
            }
        } });
    }

    void deleteAccount() {
        LinearLayout col = settingsPage("Delete account");
        add(col, text("This permanently deletes your chats, memory, projects, files and API keys.", 14, DANGER, false), 10);
        final EditText pw = input("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final EditText conf = input("Type DELETE", InputType.TYPE_CLASS_TEXT);
        add(col, pw, 10); add(col, conf, 8);
        add(col, button("Delete my account", false, new Runnable() { public void run() {
            call("POST", "/api/account/delete", obj("password", pw.getText().toString(), "confirm", conf.getText().toString()), new Runnable() { public void run() { toast("Account deleted."); logoutLocal(); } });
        } }), 12);
    }
}
