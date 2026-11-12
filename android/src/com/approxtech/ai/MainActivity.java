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
    static final int BG = Color.parseColor("#04060A");
    static final int SURFACE = Color.parseColor("#0A1324");
    static final int SURFACE2 = Color.parseColor("#0F1C34");
    static final int SURFACE3 = Color.parseColor("#15274A");
    static final int LINE = Color.parseColor("#1C2E52");
    static final int TEXT = Color.parseColor("#F4F7FB");
    static final int MUTED = Color.parseColor("#93A3BF");
    static final int GREEN = Color.parseColor("#22D37A");
    static final int TEAL = Color.parseColor("#10D9A0");
    static final int NAVY = Color.parseColor("#0B1F4A");
    static final int DANGER = Color.parseColor("#FF5D6C");
    static final int REQ_PICK_FILE = 41;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private SecureStore store;
    private Api api;
    private FrameLayout root;

    // session state
    private JSONObject user;
    private JSONArray models = new JSONArray();
    private String model = "auto";
    private String mode = "medium";
    static final String[] MODES = {"low", "medium", "high"};
    private String chatId = null;
    private String projectId = null;
    private final List<JSONObject> attachments = new ArrayList<>();
    private boolean streaming = false;

    // chat views
    private LinearLayout messageList;
    private ScrollView messageScroll;
    private TextView modelIndicator;
    private LinearLayout chipRow;
    private TextView sendBtn;
    private TextView usageNote;

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new SecureStore(this);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        String server = store.get("server", getString(R.string.default_server_url));
        if (server == null || server.length() == 0) { showServerSetup(); return; }
        api = new Api(server, store.getToken());
        if (api.getToken() == null) showLogin(); else loadSession();
    }

    @Override
    protected void onDestroy() { pool.shutdownNow(); super.onDestroy(); }

    // ------------------------------------------------------------------ async helpers
    interface Job { Object run() throws Exception; }
    interface Done { void ok(Object r); }

    void bg(final Job job, final Done done) {
        pool.execute(new Runnable() {
            public void run() {
                try {
                    final Object r = job.run();
                    ui.post(new Runnable() { public void run() { if (done != null) done.ok(r); } });
                } catch (final Exception e) {
                    ui.post(new Runnable() { public void run() { handleError(e); } });
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
            toast("Error: " + e.getMessage());
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

    TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        return t;
    }

    TextView button(String label, boolean primary, final Runnable onClick) {
        TextView b = text(label, 15, primary ? Color.parseColor("#03140C") : TEXT, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(16), dp(12), dp(16), dp(12));
        if (primary) {
            GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.parseColor("#0A5A8A"), TEAL, Color.parseColor("#8CF25B")});
            g.setCornerRadius(dp(12));
            b.setBackground(g);
        } else {
            b.setBackground(bgShape(SURFACE2, 12, LINE));
        }
        b.setClickable(true);
        b.setFocusable(true);
        b.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { onClick.run(); } });
        return b;
    }

    EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(MUTED);
        e.setTextColor(TEXT);
        e.setTextSize(16);
        e.setInputType(type);
        e.setBackground(bgShape(SURFACE2, 12, LINE));
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        e.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        return e;
    }

    LinearLayout vbox() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    LinearLayout hbox() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }

    void add(LinearLayout parent, View child, int topMarginDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topMarginDp);
        parent.addView(child, lp);
    }

    ImageView logo(int sizeDp) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(R.drawable.logo);
        iv.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
        iv.setContentDescription("Approx AI logo");
        return iv;
    }

    /** A centred, scrollable form page (auth screens). */
    LinearLayout formPage(String title, String subtitle) {
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout col = vbox();
        col.setPadding(dp(24), dp(48), dp(24), dp(24));
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.addView(logo(76));
        TextView t = text(title, 24, TEXT, true);
        t.setGravity(Gravity.CENTER);
        add(col, t, 16);
        if (subtitle != null) { TextView s = text(subtitle, 14, MUTED, false); s.setGravity(Gravity.CENTER); add(col, s, 6); }
        sv.addView(col);
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

    // ------------------------------------------------------------------ server setup
    void showServerSetup() {
        LinearLayout col = formPage("Connect to Approx AI", "Enter your Approx AI server address (HTTPS).");
        final EditText url = input("https://ai.example.com", InputType.TYPE_TEXT_VARIATION_URI);
        add(col, url, 20);
        add(col, button("Continue", true, new Runnable() { public void run() {
            try {
                final String s = Api.normalizeServer(url.getText().toString());
                final Api probe = new Api(s, null);
                bg(new Job() { public Object run() throws Exception { return probe.get("/api/version"); } }, new Done() { public void ok(Object r) {
                    JSONObject v = (JSONObject) r;
                    if (!"Approx AI".equals(v.optString("product"))) { toast("That server is not an Approx AI server."); return; }
                    store.put("server", s);
                    api = probe;
                    showLogin();
                } });
            } catch (Api.ApiException e) { toast(e.getMessage()); }
        } }), 14);
    }

    // ------------------------------------------------------------------ auth
    void showLogin() {
        LinearLayout col = formPage("Welcome back", "Sign in to Approx AI");
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        final EditText pw = input("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, email, 24);
        add(col, pw, 10);
        add(col, button("Sign in", true, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim(), "password", pw.getText().toString(), "client", "mobile");
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/login", body); } }, new Done() { public void ok(Object r) {
                JSONObject o = (JSONObject) r;
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
        add(col, link("Have a verification code?", new Runnable() { public void run() { showVerify(); } }), 0);
        add(col, link("Change server (" + api.getBase() + ")", new Runnable() { public void run() { showServerSetup(); } }), 18);
    }

    void showSignup() {
        LinearLayout col = formPage("Create your account", "Approx AI by Approx Technology");
        final EditText name = input("Name (optional)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PERSON_NAME);
        final EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        final EditText pw = input("Password (10+ chars, letters & numbers)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, name, 24); add(col, email, 10); add(col, pw, 10);
        add(col, button("Create account", true, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim(), "password", pw.getText().toString(), "display_name", name.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/signup", body); } }, new Done() { public void ok(Object r) {
                toast("Check your email for a verification code.");
                showVerify();
            } });
        } }), 16);
        add(col, link("Already have an account? Sign in", new Runnable() { public void run() { showLogin(); } }), 6);
    }

    void showVerify() {
        LinearLayout col = formPage("Verify your email", "Paste the verification code from your email.");
        final EditText code = input("Verification code", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        add(col, code, 24);
        add(col, button("Verify", true, new Runnable() { public void run() {
            final JSONObject body = obj("token", code.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/verify-email", body); } }, new Done() { public void ok(Object r) {
                toast("Email verified.");
                if (user != null) { try { user.put("email_verified", true); } catch (JSONException ignored) { } showChat(null); } else showLogin();
            } });
        } }), 16);
        final EditText email = input("Email (to resend)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        add(col, email, 28);
        add(col, button("Resend code", false, new Runnable() { public void run() {
            final JSONObject body = obj("email", email.getText().toString().trim());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/resend-verification", body); } }, new Done() { public void ok(Object r) { toast(((JSONObject) r).optString("message")); } });
        } }), 8);
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
            final JSONObject body = obj("token", code.getText().toString().trim(), "password", pw.getText().toString());
            bg(new Job() { public Object run() throws Exception { return api.post("/api/auth/reset-password", body); } }, new Done() { public void ok(Object r) { toast("Password updated. Please sign in."); showLogin(); } });
        } }), 12);
        add(col, link("Back to sign in", new Runnable() { public void run() { showLogin(); } }), 6);
    }

    void loadSession() {
        bg(new Job() { public Object run() throws Exception {
            JSONObject me = api.get("/api/auth/me");
            JSONObject m = api.get("/api/models");
            JSONObject s = api.get("/api/settings");
            return new JSONObject[]{me, m, s};
        } }, new Done() { public void ok(Object r) {
            JSONObject[] a = (JSONObject[]) r;
            user = a[0].optJSONObject("user");
            models = a[1].optJSONArray("models");
            mode = a[2].optJSONObject("settings").optString("default_mode", "medium");
            showChat(null);
        } });
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

    // ------------------------------------------------------------------ app shell: top bar + body + 3-button nav
    LinearLayout shell(View body, boolean withComposer) {
        LinearLayout page = vbox();
        LinearLayout top = hbox();
        top.setPadding(dp(14), dp(10), dp(10), dp(10));
        top.setBackgroundColor(BG);
        ImageView lg = logo(30);
        top.addView(lg);
        TextView brand = text("  Approx AI", 18, TEXT, true);
        top.addView(brand);
        View sp = new View(this); top.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
        modelIndicator = text("● " + modelName(model) + " · " + cap(mode), 13, TEXT, false);
        modelIndicator.setPadding(dp(10), dp(6), dp(10), dp(6));
        modelIndicator.setBackground(bgShape(SURFACE2, 999, LINE));
        modelIndicator.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { pickModel(); } });
        top.addView(modelIndicator);
        String initial = user == null ? "A" : (user.optString("display_name").length() > 0 ? user.optString("display_name") : user.optString("email")).substring(0, 1).toUpperCase();
        TextView av = text(initial, 14, Color.parseColor("#04121F"), true);
        av.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{TEAL, Color.parseColor("#8CF25B")});
        g.setShape(GradientDrawable.OVAL);
        av.setBackground(g);
        LinearLayout.LayoutParams avlp = new LinearLayout.LayoutParams(dp(32), dp(32));
        avlp.leftMargin = dp(8);
        av.setContentDescription("Account");
        av.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { showSettings(); } });
        top.addView(av, avlp);
        page.addView(top);
        View div = new View(this); div.setBackgroundColor(LINE); page.addView(div, new LinearLayout.LayoutParams(-1, dp(1)));
        page.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
        if (withComposer) page.addView(composer());
        page.addView(bottomNav());
        root.removeAllViews();
        root.addView(page);
        return page;
    }

    static String cap(String s) { return s.substring(0, 1).toUpperCase() + s.substring(1); }

    View bottomNav() {
        LinearLayout nav = hbox();
        nav.setBackgroundColor(SURFACE);
        String[] labels = {"New chat", "History", "Settings"};
        String[] glyphs = {"✎", "◷", "⚙"};
        for (int i = 0; i < 3; i++) {
            final int idx = i;
            LinearLayout b = vbox();
            b.setGravity(Gravity.CENTER);
            b.setPadding(0, dp(8), 0, dp(10));
            b.addView(text(glyphs[i], 18, MUTED, false));
            b.addView(text(labels[i], 12, MUTED, false));
            b.setContentDescription(labels[i]);
            b.setClickable(true);
            b.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                if (idx == 0) { chatId = null; projectId = null; attachments.clear(); showChat(null); }
                else if (idx == 1) showHistory();
                else showSettings();
            } });
            nav.addView(b, new LinearLayout.LayoutParams(0, -2, 1));
        }
        return nav;
    }

    // ------------------------------------------------------------------ chat
    void showChat(final String id) {
        chatId = id;
        messageScroll = new ScrollView(this);
        messageList = vbox();
        messageList.setPadding(dp(14), dp(12), dp(14), dp(16));
        messageScroll.addView(messageList);
        shell(messageScroll, true);
        if (id == null) {
            welcome();
        } else {
            bg(new Job() { public Object run() throws Exception { return api.get("/api/chats/" + id); } }, new Done() { public void ok(Object r) {
                JSONObject o = (JSONObject) r;
                projectId = o.optJSONObject("chat").optString("project_id", null);
                if ("null".equals(projectId)) projectId = null;
                JSONArray msgs = o.optJSONArray("messages");
                for (int i = 0; i < msgs.length(); i++) addMessage(msgs.optJSONObject(i));
                scrollDown();
            } });
        }
        refreshUsage();
    }

    void welcome() {
        LinearLayout w = vbox();
        w.setGravity(Gravity.CENTER_HORIZONTAL);
        w.setPadding(0, dp(48), 0, 0);
        w.addView(logo(72));
        String name = user != null && user.optString("display_name").length() > 0 ? ", " + user.optString("display_name").split(" ")[0] : "";
        TextView h = text("How can I help" + name + "?", 24, TEXT, true);
        h.setGravity(Gravity.CENTER);
        add(w, h, 16);
        TextView s = text("English · اردو · Roman Urdu — ask anything.", 14, MUTED, false);
        s.setGravity(Gravity.CENTER);
        add(w, s, 6);
        if (user != null && !user.optBoolean("email_verified")) {
            add(w, button("Verify your email to start chatting", false, new Runnable() { public void run() { showVerify(); } }), 18);
        }
        messageList.addView(w);
    }

    void addMessage(JSONObject m) {
        boolean isUser = "user".equals(m.optString("role"));
        LinearLayout wrap = vbox();
        wrap.setGravity(isUser ? Gravity.END : Gravity.START);
        final String content = m.optString("content");
        TextView body = text("", 15.5f, TEXT, false);
        body.setTextIsSelectable(true);
        body.setLineSpacing(0, 1.25f);
        if (isUser) {
            body.setText(content);
            body.setPadding(dp(14), dp(10), dp(14), dp(10));
            body.setBackground(bgShape(SURFACE3, 18, 0));
        } else {
            body.setText(Md.render(content));
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
            if (m.has("model_id") && !m.isNull("model_id")) meta.addView(text(modelName(m.optString("model_id")) + " · " + cap(m.optString("mode", "medium")), 12, MUTED, false));
        }
        long t = m.optLong("created_at", 0);
        if (t > 0) { TextView ts = text("  " + DateUtils.getRelativeTimeSpanString(t), 12, MUTED, false); meta.addView(ts); }
        wrap.addView(meta);
        add(messageList, wrap, 14);
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
        final EditText prompt = new EditText(this);
        prompt.setHint("Ask Approx AI anything...");
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
        bar.addView(modelChip, mlp);
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
                modelIndicator.setText("● " + modelName(model) + " · " + cap(mode));
            } });
            toggle.addView(t);
        }
        styleModes(modeBtns);
        bar.addView(toggle, mlp);
        View sp = new View(this); bar.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
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

    void styleModes(TextView[] btns) {
        for (int i = 0; i < btns.length; i++) {
            boolean on = MODES[i].equals(mode);
            btns[i].setBackground(on ? bgShape(NAVY, 999, GREEN) : null);
            btns[i].setTextColor(on ? TEXT : MUTED);
        }
    }

    TextView round(String glyph, boolean primary) {
        TextView t = text(glyph, 18, primary ? Color.parseColor("#03140C") : TEXT, true);
        t.setGravity(Gravity.CENTER);
        GradientDrawable g = primary ? new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{Color.parseColor("#0A5A8A"), TEAL, Color.parseColor("#8CF25B")}) : new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        if (!primary) { g.setColor(SURFACE2); g.setStroke(dp(1), LINE); }
        t.setBackground(g);
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
            if (m.optBoolean("available")) { ids.add(m.optString("id")); labels.add(m.optString("name") + ("unavailable".equals(m.optString("backend")) ? " (backend offline)" : "")); }
            else labels.add(m.optString("name") + " — locked (" + m.optString("tier") + ")");
            if (!m.optBoolean("available")) ids.add(null);
        }
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Model (Medium/High is a separate mode)")
                .setItems(labels.toArray(new String[0]), new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int which) {
                    String id = ids.get(which);
                    if (id == null) { toast("Your account does not have access to this model."); return; }
                    model = id;
                    if (chatId == null && messageList != null) showChat(null); else showChat(chatId);
                } }).show();
    }

    void plusMenu() {
        final String[] items = {"File", "Image", "PDF", "Document", "Camera / photo", "Data analysis (CSV/JSON)", "Research", "Code (Fabbox)", "Workspace", "Tools & connectors"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Add to message")
                .setItems(items, new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    switch (w) {
                        case 0: pick("*/*"); break;
                        case 1: case 4: pick("image/*"); break;
                        case 2: pick("application/pdf"); break;
                        case 3: pick("application/vnd.openxmlformats-officedocument.wordprocessingml.document"); break;
                        case 5: pick("text/*"); break;
                        case 6: case 7: case 8: openWeb(w == 6 ? "/#/research" : w == 7 ? "/#/code" : "/#/workspace"); break;
                        default:
                            new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Dialog_Alert).setTitle("Tools & connectors")
                                    .setMessage("Third-party connectors are not available in Approx AI 1.0. Nothing is connected to your account.").setPositiveButton("OK", null).show();
                    }
                } }).show();
    }

    void openWeb(String path) {
        toast("Opening in your browser (full Research / Fabbox / Workspace UI).");
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(api.getBase() + path)));
    }

    // ------------------------------------------------------------------ NEBIUS console
    boolean isAdmin() { return user != null && !"user".equals(user.optString("role")); }
    boolean isSuper() { return user != null && "superadmin".equals(user.optString("role")); }

    LinearLayout card(LinearLayout parent, String title) {
        LinearLayout c = vbox();
        c.setPadding(dp(14), dp(12), dp(14), dp(14));
        c.setBackground(bgShape(SURFACE2, 16, LINE));
        if (title != null) c.addView(text(title, 15, TEXT, true));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(12);
        parent.addView(c, lp);
        return c;
    }

    void kv(LinearLayout c, String k, String v) {
        LinearLayout r = hbox();
        r.setPadding(0, dp(5), 0, dp(5));
        TextView kt = text(k, 13, MUTED, false);
        r.addView(kt, new LinearLayout.LayoutParams(0, -2, 1));
        r.addView(text(v == null ? "—" : v, 13, TEXT, false));
        c.addView(r);
    }

    void showConsole(final String tab) {
        LinearLayout col = vbox();
        col.setPadding(dp(14), dp(12), dp(14), dp(24));
        col.addView(link("‹ Back to settings", new Runnable() { public void run() { showSettings(); } }));
        add(col, text("NEBIUS Console", 20, TEXT, true), 6);
        add(col, text(isAdmin() ? (isSuper() ? "Signed in as superadmin — full control." : "Signed in as admin.") : "Read-only: admin actions require an admin account.", 12, MUTED, false), 2);
        // tab bar
        LinearLayout tabs = hbox();
        tabs.setPadding(0, dp(10), 0, dp(4));
        final String[] names = {"Dashboard", "Projects", "Compute", "Models", "Settings"};
        for (final String nm : names) {
            TextView t = text(nm, 13, tab.equals(nm) ? TEXT : MUTED, tab.equals(nm));
            t.setPadding(dp(10), dp(8), dp(10), dp(8));
            if (tab.equals(nm)) t.setBackground(bgShape(NAVY, 999, GREEN));
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { showConsole(nm); } });
            tabs.addView(t);
        }
        HorizontalScrollView hsv = new HorizontalScrollView(this);
        hsv.setHorizontalScrollBarEnabled(false);
        hsv.addView(tabs);
        col.addView(hsv);
        final LinearLayout body = vbox();
        col.addView(body, new LinearLayout.LayoutParams(-1, -2));
        ScrollView sv = new ScrollView(this);
        sv.addView(col);
        shell(sv, false);

        add(body, text("Loading…", 13, MUTED, false), 12);
        if ("Projects".equals(tab)) { consoleProjects(body); return; }
        if ("Settings".equals(tab)) { body.removeAllViews(); consoleSettings(body); return; }
        // Dashboard / Compute / Models all read /api/status (+ registry/compute for admins)
        bg(new Job() { public Object run() throws Exception {
            JSONObject status = api.get("/api/status");
            JSONObject extra = new JSONObject();
            if (isAdmin()) {
                try { extra.put("registry", api.get("/api/admin/registry")); } catch (Exception ignored) {}
                try { extra.put("compute", api.get("/api/admin/compute")); } catch (Exception ignored) {}
            }
            extra.put("status", status);
            return extra;
        } }, new Done() { public void ok(Object r) {
            body.removeAllViews();
            JSONObject d = (JSONObject) r;
            if ("Dashboard".equals(tab)) consoleDashboard(body, d);
            else if ("Compute".equals(tab)) consoleCompute(body, d);
            else if ("Models".equals(tab)) consoleModels(body, d);
        } });
    }

    void consoleDashboard(LinearLayout body, JSONObject d) {
        JSONObject status = d.optJSONObject("status");
        LinearLayout c = card(body, "API");
        kv(c, "Backend", status == null ? "unreachable" : "online · " + status.optString("version", "?"));
        kv(c, "Environment", status == null ? "—" : status.optString("environment", "—"));
        JSONArray ms = status == null ? new JSONArray() : status.optJSONArray("models");
        LinearLayout mc = card(body, "Models");
        for (int i = 0; ms != null && i < ms.length(); i++) {
            JSONObject m = ms.optJSONObject(i);
            String st = m.optString("backend");
            String ver = m.isNull("active_version") ? "no active version" : "v" + m.optString("active_version");
            kv(mc, m.optString("id"), ver + " · " + st + (m.optBoolean("production_ready") ? " · live" : ""));
        }
        JSONObject gpu = status == null ? null : status.optJSONObject("gpu");
        LinearLayout gc = card(body, "Compute");
        kv(gc, "GPU workers online", gpu == null ? (isAdmin() ? "0" : "admin only") : String.valueOf(gpu.optInt("workers_online", 0)));
        JSONObject training = status == null ? null : status.optJSONObject("training");
        kv(gc, "Active training job", training == null || training.isNull("active_job") ? "none" : training.optJSONObject("active_job").optString("phase", "running"));
    }

    void consoleCompute(final LinearLayout body, JSONObject d) {
        if (!isAdmin()) { card(body, "Compute").addView(text("GPU compute controls require an admin account.", 13, MUTED, false)); return; }
        JSONObject compute = d.optJSONObject("compute");
        final JSONArray workers = compute == null ? new JSONArray() : compute.optJSONArray("workers");
        LinearLayout wc = card(body, "GPU workers");
        int online = 0;
        for (int i = 0; workers != null && i < workers.length(); i++) if (workers.optJSONObject(i).optBoolean("online")) online++;
        if (online == 0) wc.addView(text("No GPU worker connected. Start one with `run_all_training.py --worker` on a GPU runtime (Colab/NEBIUS).", 13, MUTED, false));
        for (int i = 0; workers != null && i < workers.length(); i++) {
            JSONObject w = workers.optJSONObject(i);
            if (!w.optBoolean("online")) continue;
            JSONObject g = w.optJSONObject("gpu");
            kv(wc, w.optString("name", w.optString("id")), (g == null ? "GPU" : g.optString("name") + " · " + g.optString("vram_gb") + " GB") + " · " + (w.isNull("current_job_id") ? "idle" : "busy"));
        }
        if (isSuper()) {
            TextView start = button("Start training job", true, new Runnable() { public void run() {
                final EditText in = new EditText(MainActivity.this);
                in.setText("nick-4.8");
                new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle("Models to train (\"all\" or space-separated ids)").setView(in)
                    .setPositiveButton("Queue", new DialogInterface.OnClickListener() { public void onClick(DialogInterface di, int wi) {
                        String val = in.getText().toString().trim();
                        JSONObject b = new JSONObject();
                        try { b.put("models", val.equals("all") ? "all" : new JSONArray(java.util.Arrays.asList(val.split("\\s+")))); } catch (JSONException ignored) {}
                        bg(new Job() { public Object run() throws Exception { return api.post("/api/admin/compute/jobs", b); } }, new Done() { public void ok(Object r) {
                            toast(((JSONObject) r).optString("note", "Job queued")); showConsole("Compute");
                        } });
                    } }).setNegativeButton("Cancel", null).show();
            } });
            body.addView(start, new LinearLayout.LayoutParams(-2, -2));
        }
        final JSONArray jobs = compute == null ? new JSONArray() : compute.optJSONArray("jobs");
        LinearLayout jc = card(body, "Jobs");
        if (jobs == null || jobs.length() == 0) jc.addView(text("No training jobs yet.", 13, MUTED, false));
        for (int i = 0; jobs != null && i < Math.min(jobs.length(), 8); i++) {
            final JSONObject j = jobs.optJSONObject(i);
            LinearLayout r = hbox();
            r.setPadding(0, dp(6), 0, dp(6));
            LinearLayout info = vbox();
            info.addView(text(j.optJSONArray("models") + " · " + j.optString("status"), 13, TEXT, false));
            info.addView(text(j.optString("phase", ""), 12, MUTED, false));
            r.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
            String st = j.optString("status");
            if (isSuper() && (st.equals("queued") || st.equals("running") || st.equals("stop_requested"))) {
                r.addView(link("Stop", new Runnable() { public void run() {
                    bg(new Job() { public Object run() throws Exception { return api.post("/api/admin/compute/jobs/" + j.optString("id") + "/stop", new JSONObject()); } },
                       new Done() { public void ok(Object r2) { toast("Stop requested"); showConsole("Compute"); } });
                } }));
            }
            jc.addView(r);
        }
    }

    void consoleModels(final LinearLayout body, JSONObject d) {
        JSONObject reg = d.optJSONObject("registry");
        if (reg == null) {
            JSONObject status = d.optJSONObject("status");
            JSONArray ms = status == null ? new JSONArray() : status.optJSONArray("models");
            LinearLayout c = card(body, "Models");
            for (int i = 0; ms != null && i < ms.length(); i++) {
                JSONObject m = ms.optJSONObject(i);
                kv(c, m.optString("id"), m.isNull("active_version") ? "no active version" : "v" + m.optString("active_version"));
            }
            c.addView(text("Version activation requires an admin account.", 12, MUTED, false));
            return;
        }
        JSONArray models = reg.optJSONArray("models");
        kv(card(body, "Registry"), "Models dir", reg.optString("dir", "—"));
        for (int i = 0; models != null && i < models.length(); i++) {
            final JSONObject m = models.optJSONObject(i);
            LinearLayout c = card(body, null);
            c.addView(text(m.optString("id") + (m.isNull("active_version") ? "  (no active version)" : "  · active v" + m.optString("active_version")), 15, TEXT, true));
            JSONArray versions = m.optJSONArray("versions");
            if (versions == null || versions.length() == 0) c.addView(text("No releases imported.", 13, MUTED, false));
            for (int v = 0; versions != null && v < versions.length(); v++) {
                final JSONObject ver = versions.optJSONObject(v);
                LinearLayout r = hbox();
                r.setPadding(0, dp(6), 0, dp(6));
                LinearLayout info = vbox();
                info.addView(text("v" + ver.optString("version") + " · " + ver.optString("status") + (ver.optBoolean("production_ready") ? " · production" : ""), 13, TEXT, false));
                if (ver.optJSONArray("errors") != null && ver.optJSONArray("errors").length() > 0)
                    info.addView(text(ver.optJSONArray("errors").optString(0), 12, MUTED, false));
                r.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
                boolean canActivate = isSuper() && ver.optBoolean("activatable") && !ver.optString("version").equals(m.optString("active_version"));
                if (canActivate) {
                    r.addView(link(ver.optBoolean("production_ready") ? "Activate" : "Activate (override)", new Runnable() { public void run() {
                        confirm("Activate v" + ver.optString("version"), ver.optBoolean("production_ready") ? "Make this the live version?" : "This release is NOT production-ready. Activate anyway? (audited)", new Runnable() { public void run() {
                            final JSONObject b = new JSONObject();
                            try { b.put("model_id", m.optString("id")); b.put("version", ver.optString("version")); if (!ver.optBoolean("production_ready")) { b.put("allow_non_production", true); b.put("reason", "activated from Android console"); } } catch (JSONException ignored) {}
                            bg(new Job() { public Object run() throws Exception { return api.post("/api/admin/registry/activate", b); } }, new Done() { public void ok(Object r2) { toast("Activated v" + ver.optString("version")); showConsole("Models"); } });
                        } });
                    } }));
                } else if (isSuper() && ver.optString("version").equals(m.optString("active_version"))) {
                    r.addView(link("Deactivate", new Runnable() { public void run() {
                        final JSONObject b = new JSONObject();
                        try { b.put("model_id", m.optString("id")); } catch (JSONException ignored) {}
                        bg(new Job() { public Object run() throws Exception { return api.post("/api/admin/registry/deactivate", b); } }, new Done() { public void ok(Object r2) { toast("Deactivated"); showConsole("Models"); } });
                    } }));
                }
                c.addView(r);
            }
        }
    }

    void consoleProjects(final LinearLayout body) {
        bg(new Job() { public Object run() throws Exception { return api.get("/api/projects"); } }, new Done() { public void ok(Object r) {
            body.removeAllViews();
            JSONArray ps = ((JSONObject) r).optJSONArray("projects");
            LinearLayout c = card(body, "Projects");
            if (ps == null || ps.length() == 0) c.addView(text("No projects yet. Create one from the chat composer or the web app.", 13, MUTED, false));
            for (int i = 0; ps != null && i < ps.length(); i++) {
                JSONObject p = ps.optJSONObject(i);
                kv(c, p.optString("name"), (p.optString("default_model", "auto")));
            }
        } });
    }

    void consoleSettings(LinearLayout body) {
        LinearLayout c = card(body, "Backend");
        kv(c, "Server", api.getBase());
        kv(c, "Signed in", user == null ? "—" : user.optString("email"));
        kv(c, "Role", user == null ? "—" : user.optString("role"));
        kv(c, "App version", appVersion());
        kv(c, "Build", BuildInfo.BUILD_ID);
        LinearLayout a = card(body, "Admin actions");
        if (isAdmin()) {
            a.addView(link("Open full admin console (web)", new Runnable() { public void run() { openWeb("/#/admin"); } }));
            a.addView(link("Developer / API console (web)", new Runnable() { public void run() { openWeb("/developers/"); } }));
        } else {
            a.addView(text("Admin actions require an admin account.", 13, MUTED, false));
        }
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
        row.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (!"trash".equals(view)) showChat(c.optString("id")); } });
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
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert).setTitle(c.optString("title")).setItems(items, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface d, int w) {
                final String act = items[w];
                if ("Rename".equals(act)) {
                    final EditText e = input("Title", InputType.TYPE_CLASS_TEXT);
                    e.setText(c.optString("title"));
                    new AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Dialog_Alert).setTitle("Rename").setView(e).setPositiveButton("Save", new DialogInterface.OnClickListener() {
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
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert).setTitle(title).setMessage(msg)
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
                {"Account & profile", new Runnable() { public void run() { accountSettings(); } }},
                {"Security & password", new Runnable() { public void run() { securitySettings(); } }},
                {"Memory", new Runnable() { public void run() { memorySettings(); } }},
                {"Privacy & training consent", new Runnable() { public void run() { privacySettings(); } }},
                {"Model preferences", new Runnable() { public void run() { modelSettings(); } }},
                {"Usage & quota", new Runnable() { public void run() { usageSettings(); } }},
                {"Projects", new Runnable() { public void run() { projectSettings(); } }},
                {"Files", new Runnable() { public void run() { fileSettings(); } }},
                {"Subscription", new Runnable() { public void run() { infoPage("Subscription", "Plan: " + (user == null ? "" : user.optString("plan")) + "\n\nFree: Nick 4.8 + Hike 6.5. Pro adds Sona 9.0. FAB is granted individually by Approx Technology.\n\nOnline payments are not enabled in Approx AI 1.0; upgrades are applied by an administrator."); } }},
                {"NEBIUS console (dashboard, compute, models)", new Runnable() { public void run() { showConsole("Dashboard"); } }},
                {"API & developer console", new Runnable() { public void run() { openWeb("/developers/"); } }},
                {"Connected tools", new Runnable() { public void run() { infoPage("Connected tools", "No third-party connectors are available in Approx AI 1.0."); } }},
                {"Delete account", new Runnable() { public void run() { deleteAccount(); } }},
                {"Log out", new Runnable() { public void run() { call("POST", "/api/auth/logout", new JSONObject(), new Runnable() { public void run() { logoutLocal(); } }); } }},
        };
        for (Object[] r : rows) add(col, row((String) r[0], (Runnable) r[1]), 0);
        add(col, text("Approx AI 1.0.0 · Approx Technology · " + api.getBase(), 12, MUTED, false), 18);
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
        LinearLayout col = settingsPage("Security & password");
        final EditText cur = input("Current password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final EditText nw = input("New password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(col, cur, 12); add(col, nw, 8);
        add(col, button("Change password", true, new Runnable() { public void run() {
            call("POST", "/api/auth/change-password", obj("current_password", cur.getText().toString(), "new_password", nw.getText().toString()), new Runnable() { public void run() { toast("Password changed. Other sessions signed out."); } });
        } }), 10);
        add(col, button("Sign out all other sessions", false, new Runnable() { public void run() {
            call("POST", "/api/auth/sessions/revoke-others", new JSONObject(), new Runnable() { public void run() { toast("Done"); } });
        } }), 16);
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
