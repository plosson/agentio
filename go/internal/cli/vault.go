package cli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

func vaultCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "vault", Short: "Manage the agentio vault (config + credentials)"}
	cmd.AddCommand(vaultInit(), vaultStatus(), vaultSet(), vaultPassphrase(), vaultReset(), vaultExport(), vaultImport(), vaultClear())
	return cmd
}

func vaultInit() *cobra.Command {
	var path, pass string
	var stdin, noMigrate bool
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a new vault",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if vault.Exists() {
				current, _ := vault.ReadPointer()
				return clierr.New(clierr.ConfigError,
					"A vault is already configured at "+current,
					"Use `agentio vault set` to switch, `vault passphrase` to change it, or `vault reset` to wipe it")
			}
			passphrase, err := resolvePassphrase(cmd, pass, stdin, true)
			if err != nil {
				return err
			}
			vaultPath := path
			if vaultPath == "" {
				vaultPath = vault.DefaultVaultPath()
			}
			if err := vault.ValidateVaultPath(vaultPath); err != nil {
				return err
			}
			if err := vault.ValidatePassphrase(passphrase); err != nil {
				return err
			}
			hasConfig, _ := vault.DetectLegacy()
			if hasConfig && !noMigrate {
				fmt.Fprintln(cmd.ErrOrStderr(), "Found legacy config — importing it into the new vault.")
				legacy, err := vault.ReadLegacy()
				if err != nil {
					return err
				}
				contents := vault.EmptyContents()
				contents.Config = legacy.Config
				contents.Credentials = legacy.Credentials
				if err := vault.Create(vaultPath, passphrase, contents); err != nil {
					return err
				}
				if err := vault.ArchiveLegacy(); err != nil {
					return err
				}
				if !legacy.TokensRecovered && hasConfig {
					fmt.Fprintln(cmd.ErrOrStderr(), "Warning: legacy credentials could not be recovered. Re-authenticate each service.")
				}
			} else {
				if err := vault.Create(vaultPath, passphrase, vault.EmptyContents()); err != nil {
					return err
				}
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Vault created at %s\n", vault.NormalizeVaultPath(vaultPath))
			fmt.Fprintln(cmd.OutOrStdout(), "\nNext: configure a service. Examples:")
			fmt.Fprintln(cmd.OutOrStdout(), "  agentio acme profile add")
			fmt.Fprintln(cmd.OutOrStdout(), "  agentio board profile add")
			return nil
		},
	}
	cmd.Flags().StringVar(&path, "path", "", "Where to create the vault file")
	cmd.Flags().StringVar(&pass, "passphrase", "", "Vault passphrase")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the vault passphrase from stdin")
	cmd.Flags().BoolVar(&noMigrate, "no-migrate", false, "Ignore any legacy config instead of importing it")
	return cmd
}

func vaultStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the active vault and what it holds",
		RunE: func(cmd *cobra.Command, _ []string) error {
			current, err := vault.ReadPointer()
			if err != nil {
				return err
			}
			if current == "" {
				return clierr.New(clierr.VaultNotConfigured, "No vault configured", "Run: agentio vault init")
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Path: %s\n", current)
			if _, err := os.Stat(current); err != nil {
				fmt.Fprintln(cmd.OutOrStdout(), "Exists: no (file is missing)")
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), "Exists: yes")
			}
			contents, err := vault.Load()
			if err != nil {
				fmt.Fprintln(cmd.OutOrStdout(), "Profiles: unreadable (wrong or missing passphrase)")
				return nil
			}
			n := 0
			for _, list := range contents.Config.Profiles {
				n += len(list)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Profiles: %d\n", n)
			return nil
		},
	}
}

func vaultSet() *cobra.Command {
	var pass string
	var stdin bool
	cmd := &cobra.Command{
		Use:   "set <path>",
		Short: "Point agentio at an existing vault file",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			vaultPath := vault.NormalizeVaultPath(args[0])
			if !strings.HasPrefix(vaultPath, "/") {
				// relative paths are joined to the cwd then must still be absolute after normalize of a relative file
			}
			if !isAbs(vaultPath) {
				cwd, _ := os.Getwd()
				vaultPath = vault.NormalizeVaultPath(joinPath(cwd, args[0]))
			}
			if err := vault.ValidateVaultPath(vaultPath); err != nil {
				return err
			}
			if _, err := os.Stat(vaultPath); err != nil {
				return clierr.New(clierr.NotFound, "No vault file at "+vaultPath, "Run `agentio vault init` to create a new vault, or check the path")
			}
			passphrase, err := resolvePassphrase(cmd, pass, stdin, false)
			if err != nil {
				return err
			}
			encoded, err := os.ReadFile(vaultPath)
			if err != nil {
				return err
			}
			// Count from what was decrypted: a load would take AGENTIO_PASSPHRASE first.
			var contents vault.Contents
			plain, err := vault.Decrypt(string(encoded), passphrase)
			if err == nil {
				err = json.Unmarshal([]byte(plain), &contents)
			}
			if err != nil {
				return clierr.New(clierr.AuthFailed, "Could not decrypt "+vaultPath, "Wrong passphrase, or the file is not an agentio vault")
			}
			previous, _ := vault.ReadPointer()
			if err := vault.WritePointer(vaultPath); err != nil {
				return err
			}
			vault.Reset()
			vault.SetMemoryPassphrase(passphrase)
			if err := vault.StorePassphrase(passphrase); err != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not store passphrase: %s\n", err.Error())
				fmt.Fprintln(cmd.ErrOrStderr(), "Set AGENTIO_PASSPHRASE in your environment for future commands.")
			}
			if previous == vaultPath {
				fmt.Fprintf(cmd.OutOrStdout(), "Vault unchanged: %s\n", vaultPath)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Vault set to %s\n", vaultPath)
				if previous != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "Previous: %s (left on disk)\n", previous)
				}
			}
			n := 0
			for _, list := range contents.Config.Profiles {
				n += len(list)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%d profile(s) available\n", n)
			return nil
		},
	}
	cmd.Flags().StringVar(&pass, "passphrase", "", "Vault passphrase")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the vault passphrase from stdin")
	return cmd
}

func vaultPassphrase() *cobra.Command {
	var pass string
	var stdin bool
	cmd := &cobra.Command{
		Use:   "passphrase",
		Short: "Change the passphrase of the current vault",
		RunE: func(cmd *cobra.Command, _ []string) error {
			current, err := vault.Load()
			if err != nil {
				return err
			}
			next, err := resolvePassphrase(cmd, pass, stdin, true)
			if err != nil {
				return err
			}
			if err := vault.ValidatePassphrase(next); err != nil {
				return err
			}
			vault.SetMemoryPassphrase(next)
			os.Setenv("AGENTIO_PASSPHRASE", next)
			if err := vault.Save(current); err != nil {
				return err
			}
			if err := vault.StorePassphrase(next); err != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not store passphrase: %s\n", err.Error())
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Passphrase changed")
			return nil
		},
	}
	cmd.Flags().StringVar(&pass, "passphrase", "", "New passphrase")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the new passphrase from stdin")
	return cmd
}

func vaultReset() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "reset",
		Short: "Delete the vault file, pointer, and stored passphrase",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !force {
				return clierr.New(clierr.InvalidParams,
					"Refusing to reset without confirmation and no terminal is available to prompt",
					"Re-run with --force if you are sure")
			}
			if err := vault.ResetVault(); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Vault reset. Run `agentio vault init` to start fresh.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "Skip the confirmation prompt")
	return cmd
}

func vaultExport() *cobra.Command {
	var key, file string
	var all bool
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export configuration and credentials",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !all {
				all = true
			}
			encryptionKey := key
			if encryptionKey == "" {
				buf := make([]byte, 32)
				if _, err := randRead(buf); err != nil {
					return err
				}
				encryptionKey = hexEncode(buf)
			}
			if !isHex64(encryptionKey) {
				return clierr.New(clierr.InvalidParams, "Invalid encryption key format", "Key must be exactly 64 hexadecimal characters")
			}
			contents, err := vault.Load()
			if err != nil {
				return err
			}
			exported := vault.EmptyContents()
			count := 0
			for service, list := range contents.Config.Profiles {
				for _, entry := range list {
					exported.Config.Profiles[service] = append(exported.Config.Profiles[service], vault.ProfileValue{Name: entry.Name})
					if creds, ok := contents.Credentials[service][entry.Name]; ok {
						if exported.Credentials[service] == nil {
							exported.Credentials[service] = map[string]map[string]any{}
						}
						exported.Credentials[service][entry.Name] = creds
					}
					count++
				}
			}
			if count == 0 {
				return clierr.New(clierr.NotFound, "No profiles configured", "Add profiles first with: agentio <service> profile add")
			}
			// Bun's exporter stores profile names as strings. Match that blob.
			raw := exportBlob(exported)
			enc, err := vault.Encrypt(raw, encryptionKey)
			if err != nil {
				return err
			}
			word := "profiles"
			if count == 1 {
				word = "profile"
			}
			if file != "" {
				path := file
				if !isAbs(path) {
					cwd, _ := os.Getwd()
					path = joinPath(cwd, file)
				}
				if err := os.WriteFile(path, []byte(enc), 0o600); err != nil {
					return err
				}
				fmt.Fprintf(cmd.ErrOrStderr(), "Exported %d %s to %s\n", count, word, path)
				fmt.Fprintf(cmd.OutOrStdout(), "AGENTIO_KEY=%s\n", encryptionKey)
				return nil
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "Exported %d %s\n", count, word)
			fmt.Fprintf(cmd.OutOrStdout(), "AGENTIO_KEY=%s\n", encryptionKey)
			fmt.Fprintf(cmd.OutOrStdout(), "AGENTIO_CONFIG=%s\n", enc)
			return nil
		},
	}
	cmd.Flags().StringVar(&key, "key", "", "Encryption key (64 hex characters)")
	cmd.Flags().StringVar(&file, "file", "", "Write encrypted config to a file")
	cmd.Flags().BoolVar(&all, "all", false, "Export all profiles without prompting")
	return cmd
}

func vaultImport() *cobra.Command {
	var key, pass string
	var merge, stdin bool
	cmd := &cobra.Command{
		Use:   "import [file]",
		Short: "Import configuration and credentials",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			encKey := key
			if encKey == "" {
				encKey = os.Getenv("AGENTIO_KEY")
			}
			if encKey == "" {
				return clierr.New(clierr.InvalidParams, "No encryption key provided", "Provide --key option or set AGENTIO_KEY environment variable")
			}
			if !isHex64(encKey) {
				return clierr.New(clierr.InvalidParams, "Invalid encryption key format", "Key must be exactly 64 hexadecimal characters")
			}
			var encrypted string
			if len(args) == 1 {
				path := args[0]
				if !isAbs(path) {
					cwd, _ := os.Getwd()
					path = joinPath(cwd, args[0])
				}
				b, err := os.ReadFile(path)
				if err != nil {
					return clierr.New(clierr.NotFound, "File not found: "+path, "Provide a valid path to the exported configuration file")
				}
				encrypted = string(b)
			} else if os.Getenv("AGENTIO_CONFIG") != "" {
				encrypted = os.Getenv("AGENTIO_CONFIG")
			} else {
				return clierr.New(clierr.InvalidParams, "No configuration source provided", "Provide a file path or set AGENTIO_CONFIG environment variable")
			}
			plain, err := vault.Decrypt(strings.TrimSpace(encrypted), encKey)
			if err != nil {
				return clierr.New(clierr.AuthFailed, "Failed to decrypt configuration", "Check that you are using the correct encryption key")
			}
			imported, err := decodeExport(plain)
			if err != nil {
				return err
			}
			if imported.Version != vault.CurrentVersion {
				return clierr.New(clierr.InvalidParams, fmt.Sprintf("Unsupported export version: %d", imported.Version), "This version of agentio may not support this export format")
			}
			if !vault.Exists() {
				passphrase, err := resolvePassphrase(cmd, pass, stdin, true)
				if err != nil {
					return err
				}
				if err := vault.Create(vault.DefaultVaultPath(), passphrase, imported); err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Configuration imported successfully")
				return nil
			}
			if merge {
				err = vault.Update(func(cur *vault.Contents) error {
					for service, list := range imported.Config.Profiles {
						have := map[string]bool{}
						for _, p := range cur.Config.Profiles[service] {
							have[p.Name] = true
						}
						for _, entry := range list {
							if !have[entry.Name] {
								cur.Config.Profiles[service] = append(cur.Config.Profiles[service], entry)
							}
						}
					}
					for service, creds := range imported.Credentials {
						if cur.Credentials[service] == nil {
							cur.Credentials[service] = map[string]map[string]any{}
						}
						for name, c := range creds {
							if _, ok := cur.Credentials[service][name]; !ok {
								cur.Credentials[service][name] = c
							}
						}
					}
					return nil
				})
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Configuration merged successfully")
				return nil
			}
			err = vault.Update(func(cur *vault.Contents) error {
				cur.Config.Profiles = imported.Config.Profiles
				cur.Credentials = imported.Credentials
				profile.Prune(cur)
				return nil
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Configuration imported successfully")
			return nil
		},
	}
	cmd.Flags().StringVar(&key, "key", "", "Encryption key (64 hex characters)")
	cmd.Flags().BoolVar(&merge, "merge", false, "Merge with existing configuration instead of replacing")
	cmd.Flags().StringVar(&pass, "passphrase", "", "Passphrase when creating a vault")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read that passphrase from stdin")
	return cmd
}

func vaultClear() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "clear",
		Short: "Clear all configuration and credentials",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !force {
				return clierr.New(clierr.InvalidParams, "Refusing to clear without --force", "Re-run with --force if you are sure")
			}
			if err := vault.Update(func(cur *vault.Contents) error {
				cur.Config = vault.Config{Profiles: map[string][]vault.ProfileValue{}}
				cur.Credentials = map[string]map[string]map[string]any{}
				return nil
			}); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Configuration cleared")
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "Skip confirmation prompt")
	return cmd
}

func resolvePassphrase(cmd *cobra.Command, flag string, fromStdin, _ bool) (string, error) {
	if flag != "" && fromStdin {
		return "", clierr.New(clierr.InvalidParams, "--passphrase and --passphrase-stdin are mutually exclusive", "")
	}
	if fromStdin {
		b, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return "", err
		}
		return strings.TrimRight(string(b), "\r\n"), nil
	}
	if flag != "" {
		return flag, nil
	}
	if v := strings.TrimSpace(os.Getenv("AGENTIO_PASSPHRASE")); v != "" {
		return v, nil
	}
	return "", clierr.New(clierr.InvalidParams,
		"Passphrase required",
		"Pass --passphrase, --passphrase-stdin, or set AGENTIO_PASSPHRASE")
}

func randRead(b []byte) (int, error) { return rand.Read(b) }

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

func isAbs(path string) bool { return filepath.IsAbs(path) }

func joinPath(a, b string) string { return filepath.Join(a, b) }

// exportBlob matches Bun's exporter: profile entries are bare names, and API
// keys stay out of the blob.
func exportBlob(c *vault.Contents) string {
	profiles := map[string][]string{}
	for service, list := range c.Config.Profiles {
		for _, entry := range list {
			profiles[service] = append(profiles[service], entry.Name)
		}
	}
	body := map[string]any{
		"version":     c.Version,
		"config":      map[string]any{"profiles": profiles},
		"credentials": c.Credentials,
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func decodeExport(plain string) (*vault.Contents, error) {
	dec := json.NewDecoder(strings.NewReader(plain))
	dec.UseNumber()
	var c vault.Contents
	if err := dec.Decode(&c); err != nil {
		return nil, clierr.New(clierr.InvalidParams, "Export is not valid JSON", "")
	}
	if c.Config.Profiles == nil {
		c.Config.Profiles = map[string][]vault.ProfileValue{}
	}
	if c.Credentials == nil {
		c.Credentials = map[string]map[string]map[string]any{}
	}
	return &c, nil
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
