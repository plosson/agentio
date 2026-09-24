package oauth

import (
        "context"
        "encoding/json"
        "fmt"
        "net"
        "net/http"
        "os"
        "os/exec"
        "runtime"
        "time"

        "golang.org/x/oauth2"
        "golang.org/x/oauth2/google"
)

const (
        googleClientID     = "931954287794-4rflctl8lotok5d6rnd4o6teuk02lked.apps.googleusercontent.com"
        googleClientSecret = "H2nByOfMnoQDg9BIGMyt_hznzMMTq-Or4wsZwiqT1ldl6z7bTMIdk9L8rDzQJ4l0i_pA"
)

// GmailScopes match src/plugins/google/oauth.ts
var GmailScopes = []string{
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
        "https://www.googleapis.com/auth/userinfo.email",
}

type TokenBundle struct {
        AccessToken  string `json:"access_token"`
        RefreshToken string `json:"refresh_token,omitempty"`
        ExpiryDate   int64  `json:"expiry_date,omitempty"`
        TokenType    string `json:"token_type,omitempty"`
        Scope        string `json:"scope,omitempty"`
        Email        string `json:"email,omitempty"`
}

func GoogleConfig(redirectURL string) (*oauth2.Config, error) {
        secret, err := Reveal(googleClientSecret)
        if err != nil {
                return nil, err
        }
        return &oauth2.Config{
                ClientID:     googleClientID,
                ClientSecret: secret,
                RedirectURL:  redirectURL,
                Scopes:       GmailScopes,
                Endpoint:     google.Endpoint,
        }, nil
}

// PerformGmailOAuth runs the loopback OAuth flow on ports 3000-3010 (Bun parity).
func PerformGmailOAuth(ctx context.Context) (*TokenBundle, error) {
        var ln net.Listener
        var port int
        var err error
        for p := 3000; p <= 3010; p++ {
                ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
                if err == nil {
                        port = p
                        break
                }
        }
        if ln == nil {
                return nil, fmt.Errorf("no available port in range 3000-3010")
        }
        defer ln.Close()

        redirect := fmt.Sprintf("http://localhost:%d/callback", port)
        cfg, err := GoogleConfig(redirect)
        if err != nil {
                return nil, err
        }

        codeCh := make(chan string, 1)
        errCh := make(chan error, 1)
        mux := http.NewServeMux()
        mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
                if e := r.URL.Query().Get("error"); e != "" {
                        _, _ = w.Write([]byte("<html><body><h1>Authorization Failed</h1></body></html>"))
                        errCh <- fmt.Errorf("oauth error: %s", e)
                        return
                }
                code := r.URL.Query().Get("code")
                if code == "" {
                        _, _ = w.Write([]byte("<html><body><h1>Missing Authorization Code</h1></body></html>"))
                        errCh <- fmt.Errorf("missing code")
                        return
                }
                _, _ = w.Write([]byte("<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>"))
                codeCh <- code
        })
        srv := &http.Server{Handler: mux}
        go func() { _ = srv.Serve(ln) }()
        defer srv.Close()

        authURL := cfg.AuthCodeURL("state", oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"))
        fmt.Fprintf(os.Stderr, "\nOpen this URL to authorize Gmail:\n\n  %s\n\nWaiting for redirect on localhost:%d ...\n", authURL, port)
        launchBrowser(authURL)

        var code string
        select {
        case code = <-codeCh:
        case err = <-errCh:
                return nil, err
        case <-ctx.Done():
                return nil, ctx.Err()
        case <-time.After(5 * time.Minute):
                return nil, fmt.Errorf("oauth timed out after 5 minutes")
        }

        tok, err := cfg.Exchange(ctx, code)
        if err != nil {
                return nil, err
        }
        bundle := &TokenBundle{
                AccessToken:  tok.AccessToken,
                RefreshToken: tok.RefreshToken,
                TokenType:    tok.TokenType,
        }
        if s, ok := tok.Extra("scope").(string); ok {
                bundle.Scope = s
        }
        if !tok.Expiry.IsZero() {
                bundle.ExpiryDate = tok.Expiry.UnixMilli()
        }
        if email, err := FetchUserEmail(ctx, tok.AccessToken); err == nil {
                bundle.Email = email
        }
        return bundle, nil
}

func FetchUserEmail(ctx context.Context, accessToken string) (string, error) {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/oauth2/v2/userinfo", nil)
        if err != nil {
                return "", err
        }
        req.Header.Set("Authorization", "Bearer "+accessToken)
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        if resp.StatusCode != http.StatusOK {
                return "", fmt.Errorf("userinfo status %d", resp.StatusCode)
        }
        var body struct {
                Email string `json:"email"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
                return "", err
        }
        return body.Email, nil
}

func TokenSource(ctx context.Context, bundle *TokenBundle) (oauth2.TokenSource, error) {
        cfg, err := GoogleConfig("http://localhost")
        if err != nil {
                return nil, err
        }
        tok := &oauth2.Token{
                AccessToken:  bundle.AccessToken,
                RefreshToken: bundle.RefreshToken,
                TokenType:    bundle.TokenType,
        }
        if bundle.ExpiryDate > 0 {
                tok.Expiry = time.UnixMilli(bundle.ExpiryDate)
        }
        return cfg.TokenSource(ctx, tok), nil
}

func BundleFromMap(m map[string]any) *TokenBundle {
        b := &TokenBundle{}
        if v, ok := m["access_token"].(string); ok {
                b.AccessToken = v
        }
        if v, ok := m["refresh_token"].(string); ok {
                b.RefreshToken = v
        }
        if v, ok := m["token_type"].(string); ok {
                b.TokenType = v
        }
        if v, ok := m["scope"].(string); ok {
                b.Scope = v
        }
        if v, ok := m["email"].(string); ok {
                b.Email = v
        }
        switch v := m["expiry_date"].(type) {
        case float64:
                b.ExpiryDate = int64(v)
        case int64:
                b.ExpiryDate = v
        case json.Number:
                n, _ := v.Int64()
                b.ExpiryDate = n
        }
        return b
}

func (b *TokenBundle) ToMap() map[string]any {
        m := map[string]any{
                "access_token": b.AccessToken,
                "token_type":   b.TokenType,
        }
        if b.RefreshToken != "" {
                m["refresh_token"] = b.RefreshToken
        }
        if b.ExpiryDate != 0 {
                m["expiry_date"] = b.ExpiryDate
        }
        if b.Scope != "" {
                m["scope"] = b.Scope
        }
        if b.Email != "" {
                m["email"] = b.Email
        }
        return m
}

func launchBrowser(url string) {
        var cmd *exec.Cmd
        switch runtime.GOOS {
        case "darwin":
                cmd = exec.Command("open", url)
        case "windows":
                cmd = exec.Command("cmd", "/c", "start", "", url)
        default:
                cmd = exec.Command("xdg-open", url)
        }
        _ = cmd.Start()
}
