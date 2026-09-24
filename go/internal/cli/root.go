package cli

import (
        "bufio"
        "context"
        "fmt"
        "os"
        "strings"
        "time"

        "github.com/plosson/agentio/go/internal/daemon"
        "github.com/plosson/agentio/go/internal/gmail"
        "github.com/plosson/agentio/go/internal/oauth"
        "github.com/plosson/agentio/go/internal/vault"
        "github.com/spf13/cobra"
)

const Version = "0.0.0-go-skeleton"

func NewRoot() *cobra.Command {
        root := &cobra.Command{
                Use:           "agentio",
                Short:         "AgentIO Go port skeleton (vault + daemon + gmail)",
                SilenceUsage:  true,
                SilenceErrors: true,
        }
        root.AddCommand(versionCmd(), vaultCmd(), daemonCmd(), gmailCmd())
        return root
}

func versionCmd() *cobra.Command {
        return &cobra.Command{
                Use:   "version",
                Short: "Print version",
                Run: func(cmd *cobra.Command, args []string) {
                        fmt.Println(Version)
                },
        }
}

func vaultCmd() *cobra.Command {
        cmd := &cobra.Command{Use: "vault", Short: "Manage the vault"}
        var path string
        var passphraseStdin bool
        initCmd := &cobra.Command{
                Use:   "init",
                Short: "Create a new vault",
                RunE: func(cmd *cobra.Command, args []string) error {
                        pw, err := readPassphrase(passphraseStdin)
                        if err != nil {
                                return err
                        }
                        s, err := vault.Init(path, pw)
                        if err != nil {
                                return err
                        }
                        fmt.Printf("Vault created at %s\n", s.Path())
                        fmt.Println("\nNext: agentio gmail profile add")
                        return nil
                },
        }
        initCmd.Flags().StringVar(&path, "path", "", "Vault file path")
        initCmd.Flags().BoolVar(&passphraseStdin, "passphrase-stdin", false, "Read passphrase from stdin")

        statusCmd := &cobra.Command{
                Use:   "status",
                Short: "Show vault status",
                RunE: func(cmd *cobra.Command, args []string) error {
                        p, err := vault.ReadPointer()
                        if err != nil {
                                if os.IsNotExist(err) {
                                        fmt.Println("No vault configured")
                                        return nil
                                }
                                return err
                        }
                        fmt.Printf("Vault path: %s\n", p)
                        if _, err := os.Stat(p); err != nil {
                                fmt.Println("Vault file: missing")
                                return nil
                        }
                        fmt.Println("Vault file: present")
                        if pw := os.Getenv("AGENTIO_PASSPHRASE"); pw != "" {
                                s, err := vault.Open(pw)
                                if err != nil {
                                        fmt.Printf("Unlock: failed (%v)\n", err)
                                        return nil
                                }
                                fmt.Println("Unlock: ok")
                                for _, svc := range []string{"gmail"} {
                                        profiles := s.ListProfiles(svc)
                                        fmt.Printf("Profiles %s: %d\n", svc, len(profiles))
                                        for _, pr := range profiles {
                                                fmt.Printf("  - %s\n", pr.Name)
                                        }
                                }
                        } else {
                                fmt.Println("Unlock: locked (set AGENTIO_PASSPHRASE)")
                        }
                        return nil
                },
        }
        cmd.AddCommand(initCmd, statusCmd)
        return cmd
}

func daemonCmd() *cobra.Command {
        cmd := &cobra.Command{Use: "daemon", Short: "Run the local HTTP daemon"}
        cmd.AddCommand(&cobra.Command{
                Use:   "start",
                Short: "Run the daemon in the foreground",
                RunE: func(cmd *cobra.Command, args []string) error {
                        return daemon.Start(cmd.Context(), Version)
                },
        })
        return cmd
}

func gmailCmd() *cobra.Command {
        cmd := &cobra.Command{Use: "gmail", Short: "Gmail operations (Go skeleton)"}
        var profile string

        profileCmd := &cobra.Command{Use: "profile", Short: "Manage Gmail profiles"}
        profileCmd.AddCommand(&cobra.Command{
                Use:   "add",
                Short: "Add a Gmail profile via OAuth",
                RunE: func(cmd *cobra.Command, args []string) error {
                        return gmailProfileAdd(cmd.Context(), profile)
                },
        })
        profileCmd.PersistentFlags().StringVar(&profile, "profile", "", "Profile name (defaults to Google email)")
        profileCmd.AddCommand(&cobra.Command{
                Use:   "list",
                Short: "List Gmail profiles",
                RunE: func(cmd *cobra.Command, args []string) error {
                        s, err := openStore()
                        if err != nil {
                                return err
                        }
                        for _, p := range s.ListProfiles("gmail") {
                                ro := ""
                                if p.ReadOnly {
                                        ro = " (read-only)"
                                }
                                fmt.Printf("%s%s\n", p.Name, ro)
                        }
                        return nil
                },
        })

        labelsCmd := &cobra.Command{Use: "labels", Short: "Gmail labels"}
        labelsCmd.AddCommand(&cobra.Command{
                Use:   "list",
                Short: "List labels",
                RunE: func(cmd *cobra.Command, args []string) error {
                        client, name, err := gmailClient(cmd.Context(), profile)
                        if err != nil {
                                return err
                        }
                        labels, err := client.ListLabels(cmd.Context())
                        if err != nil {
                                return err
                        }
                        fmt.Printf("Profile: %s\n%s", name, gmail.FormatLabels(labels))
                        return nil
                },
        })
        labelsCmd.PersistentFlags().StringVar(&profile, "profile", "", "Profile name")

        whoami := &cobra.Command{
                Use:   "profile-info",
                Short: "Show Gmail mailbox profile (users.getProfile)",
                RunE: func(cmd *cobra.Command, args []string) error {
                        client, name, err := gmailClient(cmd.Context(), profile)
                        if err != nil {
                                return err
                        }
                        p, err := client.GetProfile(cmd.Context())
                        if err != nil {
                                return err
                        }
                        fmt.Printf("CLI profile: %s\nEmail: %s\nMessages: %d\nThreads: %d\n", name, p.EmailAddress, p.MessagesTotal, p.ThreadsTotal)
                        return nil
                },
        }
        whoami.Flags().StringVar(&profile, "profile", "", "Profile name")

        cmd.AddCommand(profileCmd, labelsCmd, whoami)
        return cmd
}

func gmailProfileAdd(ctx context.Context, profileName string) error {
        s, err := openStore()
        if err != nil {
                return err
        }
        fmt.Fprintln(os.Stderr, "\nGmail OAuth setup (Go skeleton)")
        ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
        defer cancel()
        bundle, err := oauth.PerformGmailOAuth(ctx)
        if err != nil {
                return err
        }
        name := profileName
        if name == "" {
                name = bundle.Email
        }
        if name == "" {
                name = "default"
        }
        if err := s.PutProfile("gmail", vault.ProfileEntry{Name: name}, bundle.ToMap()); err != nil {
                return err
        }
        fmt.Printf("Profile saved: gmail/%s", name)
        if bundle.Email != "" {
                fmt.Printf(" (%s)", bundle.Email)
        }
        fmt.Println()
        fmt.Println("Try: agentio gmail profile-info")
        fmt.Println("     agentio gmail labels list")
        return nil
}

func openStore() (*vault.Store, error) {
        pw, err := vault.ResolvePassphrase()
        if err != nil {
                return nil, err
        }
        return vault.Open(pw)
}

func gmailClient(ctx context.Context, profileFlag string) (*gmail.Client, string, error) {
        s, err := openStore()
        if err != nil {
                return nil, "", err
        }
        profiles := s.ListProfiles("gmail")
        if len(profiles) == 0 {
                return nil, "", fmt.Errorf("no gmail profiles; run: agentio gmail profile add")
        }
        name := profileFlag
        if name == "" {
                if len(profiles) != 1 {
                        names := make([]string, len(profiles))
                        for i, p := range profiles {
                                names[i] = p.Name
                        }
                        return nil, "", fmt.Errorf("multiple gmail profiles; pass --profile (%s)", strings.Join(names, ", "))
                }
                name = profiles[0].Name
        }
        creds, err := s.GetCredentials("gmail", name)
        if err != nil {
                return nil, "", err
        }
        bundle := oauth.BundleFromMap(creds)
        client, err := gmail.NewClient(ctx, bundle)
        return client, name, err
}

func readPassphrase(fromStdin bool) (string, error) {
        if fromStdin {
                b, err := bufio.NewReader(os.Stdin).ReadString('\n')
                if err != nil && len(b) == 0 {
                        return "", err
                }
                return strings.TrimRight(b, "\r\n"), nil
        }
        if v := os.Getenv("AGENTIO_PASSPHRASE"); v != "" {
                return v, nil
        }
        fmt.Fprint(os.Stderr, "Passphrase: ")
        b, err := bufio.NewReader(os.Stdin).ReadString('\n')
        if err != nil && len(b) == 0 {
                return "", err
        }
        return strings.TrimRight(b, "\r\n"), nil
}
