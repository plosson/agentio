package cli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

func vaultCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "vault", Short: "Manage the agentio vault (config + credentials)"}
	cmd.AddCommand(vaultInit(), vaultPassphrase(), vaultReset(), vaultExport(), vaultImport(), vaultClear(), vaultStatus(), vaultSet())
	return cmd
}

func vaultInit() *cobra.Command {
	var path, pass string
	var stdin bool
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Create a new vault",
		Example: `  # interactive first-time setup
  agentio vault init

  # non-interactive, passphrase piped in
  printf %s "$VAULT_PW" | agentio vault init --path ~/.config/agentio/vault.enc --passphrase-stdin

  # create a fresh vault, ignoring any legacy config on this machine
  agentio vault init --no-migrate

To use a vault that already exists, run 'agentio vault set <path>' instead.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			exists, err := vault.Present()
			if err != nil {
				return err
			}
			if exists {
				current, _ := vault.ReadPointer()
				return clierr.New(clierr.ConfigError,
					"A vault is already configured at "+current,
					"Use `agentio vault set` to switch, `vault passphrase` to change it, or `vault reset` to wipe it")
			}
			vaultPath := path
			if !cmd.Flags().Changed("path") {
				var err error
				if vaultPath, err = promptVaultPath(cmd); err != nil {
					return err
				}
			}
			passphrase, err := resolvePassphrase(cmd, pass, stdin, true)
			if err != nil {
				return err
			}
			if err := vault.ValidateVaultPath(vaultPath); err != nil {
				return err
			}
			if err := vault.ValidatePassphrase(passphrase); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			hasConfig, _ := vault.DetectLegacy()
			if migrate, _ := cmd.Flags().GetBool("migrate"); !hasConfig || !migrate {
				if err := createVault(cmd, vaultPath, passphrase, vault.EmptyContents()); err != nil {
					return err
				}
				return nudgeFirstService(cmd)
			}
			fmt.Fprintln(cmd.ErrOrStderr(), "Found legacy config — importing it into the new vault.")
			target := prepareVaultPath(cmd, vaultPath)
			legacy, err := vault.ReadLegacy()
			if err != nil {
				return err
			}
			contents := vault.EmptyContents()
			contents.Config = legacy.Config
			contents.Credentials = legacy.Credentials
			if err := vault.CreateFile(target, passphrase, contents); err != nil {
				return err
			}
			if err := vault.ArchiveLegacy(); err != nil {
				return err
			}
			storePassphrase(cmd, passphrase)
			configPath, tokensPath := vault.LegacyPaths()
			fmt.Fprintf(out, "Vault created at %s\n", target)
			preserved := configPath + ".bak"
			if _, err := os.Stat(tokensPath + ".bak"); err == nil {
				preserved += " and " + tokensPath + ".bak"
			}
			fmt.Fprintf(out, "Legacy files preserved at %s\n", preserved)
			fmt.Fprintln(out, "Delete them once you have confirmed the vault works.")
			if !legacy.TokensRecovered {
				fmt.Fprintln(cmd.ErrOrStderr(), "Warning: legacy credentials could not be recovered. Re-authenticate each service.")
			}
			return nudgeFirstService(cmd)
		},
	}
	cmd.Flags().StringVar(&path, "path", "", "Where to create the vault file")
	cmd.Flags().StringVar(&pass, "passphrase", "", "Vault passphrase (visible in shell history and process list)")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the vault passphrase from stdin")
	addNegation(cmd.Flags(), "migrate", "Ignore any legacy config instead of importing it")
	return cmd
}

// promptVaultPath is Bun's location prompt: on a terminal it asks, with the
// default path, until the answer is absolute; otherwise the default path.
func promptVaultPath(cmd *cobra.Command) (string, error) {
	def := vault.DefaultVaultPath()
	p := host.NewPrompter(streams(cmd))
	if !p.Interactive() {
		return def, nil
	}
	return p.Input("Vault file location:", def, func(v string) string {
		if !isAbs(v) {
			return "Path must be absolute"
		}
		return ""
	})
}

// prepareVaultPath is the normalised vault path, named when it differs.
func prepareVaultPath(cmd *cobra.Command, vaultPath string) string {
	target := vault.NormalizeVaultPath(vaultPath)
	if target != vaultPath {
		fmt.Fprintf(cmd.OutOrStdout(), "Path is a directory; using %s\n", target)
	}
	return target
}

// createVault is Bun's createVault: the vault file, the pointer, then the
// passphrase, whose store failing is only a warning.
func createVault(cmd *cobra.Command, vaultPath, passphrase string, contents *vault.Contents) error {
	target := prepareVaultPath(cmd, vaultPath)
	if err := vault.CreateFile(target, passphrase, contents); err != nil {
		return err
	}
	storePassphrase(cmd, passphrase)
	fmt.Fprintf(cmd.OutOrStdout(), "Vault created at %s\n", target)
	return nil
}

// storePassphrase is Bun's: a store that fails leaves a warning.
func storePassphrase(cmd *cobra.Command, passphrase string) {
	if err := vault.StorePassphrase(passphrase); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not store passphrase: %s\n", err.Error())
		fmt.Fprintln(cmd.ErrOrStderr(), "Set AGENTIO_PASSPHRASE in your environment for future commands.")
	}
}

// nudgeFirstService suggests a first service while the vault has no profile.
func nudgeFirstService(cmd *cobra.Command) error {
	contents, err := vault.Load()
	if err != nil {
		return err
	}
	for _, service := range contents.Config.Profiles.Services() {
		if len(contents.Config.Profiles.Get(service)) > 0 {
			return nil
		}
	}
	out := cmd.OutOrStdout()
	fmt.Fprintln(out, "")
	fmt.Fprintln(out, "Next: configure a service. Examples:")
	fmt.Fprintln(out, "  agentio gmail profile add")
	fmt.Fprintln(out, "  agentio slack profile add")
	fmt.Fprintln(out, "Run `agentio --help` to see all available services.")
	return nil
}

func vaultStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the active vault and what it holds",
		Example: `  # show the active vault path and profile count
  agentio vault status`,
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
			n := profileCount(contents)
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
		Example: `  # switch to another vault, prompting for the passphrase
  agentio vault set ~/Dropbox/agentio/work.vault

  # non-interactive, passphrase piped in (keeps it out of history and ps)
  printf %s "$VAULT_PW" | agentio vault set /path/to/work.vault --passphrase-stdin

  # non-interactive via the environment
  AGENTIO_PASSPHRASE="$VAULT_PW" agentio vault set /path/to/work.vault

  # non-interactive as a flag (visible in shell history and process list)
  agentio vault set /path/to/work.vault --passphrase "$VAULT_PW"

Only the pointer and the stored passphrase change - neither vault file is
moved, written to, or deleted. Run 'agentio doctor' to see the active vault.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Bun normalizeVaultPath(resolve(path)): path.resolve is filepath.Abs.
			resolved, err := filepath.Abs(args[0])
			if err != nil {
				return err
			}
			vaultPath := vault.NormalizeVaultPath(resolved)
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
			contents, err := vault.DecryptContents(string(encoded), passphrase)
			if err != nil {
				return clierr.New(clierr.AuthFailed, "Could not decrypt "+vaultPath, "Wrong passphrase, or the file is not an agentio vault")
			}
			previous, _ := vault.ReadPointer()
			if err := vault.WritePointer(vaultPath); err != nil {
				return err
			}
			vault.Reset()
			vault.SetMemoryPassphrase(passphrase)
			storePassphrase(cmd, passphrase)
			if previous == vaultPath {
				fmt.Fprintf(cmd.OutOrStdout(), "Vault unchanged: %s\n", vaultPath)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Vault set to %s\n", vaultPath)
				if previous != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "Previous: %s (left on disk)\n", previous)
				}
			}
			n := profileCount(contents)
			fmt.Fprintf(cmd.OutOrStdout(), "%d profile(s) available\n", n)
			return nil
		},
	}
	describeArgument(cmd, "path", "Path to the vault file")
	cmd.Flags().StringVar(&pass, "passphrase", "", "Vault passphrase (visible in shell history and process list)")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the vault passphrase from stdin")
	return cmd
}

func vaultPassphrase() *cobra.Command {
	var pass string
	var stdin bool
	cmd := &cobra.Command{
		Use:   "passphrase",
		Short: "Change the passphrase of the current vault",
		Example: `  # change the passphrase, prompting for the new one
  agentio vault passphrase

  # non-interactive
  printf %s "$NEW_PW" | agentio vault passphrase --passphrase-stdin`,
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
			storePassphrase(cmd, next)
			fmt.Fprintln(cmd.OutOrStdout(), "Passphrase changed")
			return nil
		},
	}
	cmd.Flags().StringVar(&pass, "passphrase", "", "New passphrase (visible in shell history and process list)")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read the new passphrase from stdin")
	return cmd
}

func vaultReset() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "reset",
		Short: "Delete the vault file, pointer, and stored passphrase",
		Example: `  # wipe the vault (asks for confirmation)
  agentio vault reset

  # wipe non-interactively (CI / scripted reset)
  agentio vault reset --force

This deletes the vault file itself. To simply stop using a vault without
destroying it, point agentio elsewhere with 'agentio vault set <path>'.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !force {
				p := host.NewPrompter(streams(cmd))
				if !p.Interactive() {
					return clierr.New(clierr.InvalidParams,
						"Refusing to reset without confirmation and no terminal is available to prompt",
						"Re-run with --force if you are sure")
				}
				ok, err := p.YesNo("This will delete the vault, pointer, and stored passphrase. Continue?", false)
				if err != nil {
					return err
				}
				if !ok {
					fmt.Fprintln(cmd.ErrOrStderr(), "Aborted")
					return nil
				}
			}
			if err := vault.RemoveLegacyBackups(); err != nil {
				return err
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
		Short: "Export configuration and credentials (as environment variables by default, or to a file)",
		Example: `  # interactive picker, prints AGENTIO_KEY=… and AGENTIO_CONFIG=… to stdout
  agentio vault export

  # export every profile non-interactively (good in scripts / CI)
  agentio vault export --all

  # write the encrypted blob to a file; only AGENTIO_KEY goes to stdout
  agentio vault export --all --file ./agentio.enc

  # bring your own encryption key (64 hex chars)
  agentio vault export --all --key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
		RunE: func(cmd *cobra.Command, _ []string) error {
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
			var profiles []selection
			for _, service := range contents.Config.Profiles.Services() {
				for _, entry := range contents.Config.Profiles.Get(service) {
					profiles = append(profiles, selection{service, entry.Name})
				}
			}
			if len(profiles) == 0 {
				return clierr.New(clierr.NotFound, "No profiles configured", "Add profiles first with: agentio <service> profile add")
			}
			selected := profiles
			if p := host.NewPrompter(streams(cmd)); !all && p.Interactive() {
				choice, err := p.Select("What would you like to export?", []plugins.Choice{
					{Name: fmt.Sprintf("All profiles (%d)", len(profiles))},
					{Name: "Select specific profiles"},
				}, 0)
				if err != nil {
					return err
				}
				if choice == 1 {
					choices := make([]plugins.Choice, len(profiles))
					for i, sel := range profiles {
						choices[i] = plugins.Choice{Name: sel.service + ": " + sel.name}
					}
					picked, err := p.Checkbox("Select profiles to export:", choices, true)
					if err != nil {
						return err
					}
					selected = nil
					for _, i := range picked {
						selected = append(selected, profiles[i])
					}
				}
			}
			count := len(selected)
			raw := exportBlob(contents, selected)
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
	cmd.Flags().StringVar(&key, "key", "", "Encryption key (64 hex characters). If not provided, a random key will be generated")
	cmd.Flags().StringVar(&file, "file", "", "Write encrypted config to file instead of outputting AGENTIO_CONFIG")
	cmd.Flags().BoolVar(&all, "all", false, "Export all profiles without prompting for selection")
	return cmd
}

func vaultImport() *cobra.Command {
	var key, pass string
	var merge, stdin bool
	cmd := &cobra.Command{
		Use:   "import [file]",
		Short: "Import configuration and credentials from an encrypted file or environment variables",
		Example: `  # import from a file (key passed inline)
  agentio vault import ./agentio.enc --key 0123…cdef

  # import from AGENTIO_CONFIG env var, key from AGENTIO_KEY env var
  AGENTIO_KEY=… AGENTIO_CONFIG=… agentio vault import

  # merge into existing config (only adds missing profiles/credentials)
  agentio vault import ./agentio.enc --key 0123…cdef --merge

When no vault exists yet, import creates one at the default path. The passphrase
for it resolves like 'vault init': --passphrase-stdin, --passphrase, then
AGENTIO_PASSPHRASE; off a TTY one of those is required.`,
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
				return errUndecryptable
			}
			imported, err := decodeExport(plain)
			if err != nil {
				return err
			}
			exists, err := vault.Present()
			if err != nil {
				return err
			}
			if !exists {
				passphrase, err := resolvePassphrase(cmd, pass, stdin, true)
				if err != nil {
					return err
				}
				if err := vault.ValidatePassphrase(passphrase); err != nil {
					return err
				}
				// Bun: `{ version, config: exportData.config, credentials: exportData.credentials }`.
				fresh := &vault.Contents{Version: vault.CurrentVersion, Config: imported.Config, Credentials: imported.Credentials}
				if err := createVault(cmd, vault.DefaultVaultPath(), passphrase, fresh); err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Configuration imported successfully")
				return nil
			}
			if merge {
				// Bun: add what is missing, never overwrite; each service
				// `??= []` / `??= {}`, so a new one goes last.
				err = vault.Update(func(cur *vault.Contents) error {
					for _, service := range imported.Config.Profiles.Services() {
						list := imported.Config.Profiles.Get(service)
						if list == nil {
							continue
						}
						current := cur.Config.Profiles.Get(service)
						if current == nil {
							current = []vault.ProfileValue{}
						}
						for _, entry := range list {
							if findEntry(current, entry.Name) == -1 {
								current = append(current, entry)
							}
						}
						cur.Config.Profiles.Set(service, current)
					}
					for _, service := range imported.Credentials.Services() {
						for _, name := range imported.Credentials.Profiles(service) {
							c, _ := imported.Credentials.Raw(service, name)
							cur.Credentials.AddMissing(service, name, c)
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
	describeArgument(cmd, "file", "Path to the encrypted configuration file (optional if AGENTIO_CONFIG env var is set)")
	cmd.Flags().StringVar(&key, "key", "", "Encryption key (64 hex characters). Falls back to AGENTIO_KEY env var")
	cmd.Flags().BoolVar(&merge, "merge", false, "Merge with existing configuration instead of replacing")
	cmd.Flags().StringVar(&pass, "passphrase", "", "Passphrase for the vault created when none exists yet (visible in shell history and process list)")
	cmd.Flags().BoolVar(&stdin, "passphrase-stdin", false, "Read that passphrase from stdin")
	return cmd
}

func vaultClear() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "clear",
		Short: "Clear all configuration and credentials",
		Example: `  # interactive: deletes all profiles and credentials after confirmation
  agentio vault clear

  # non-interactive (CI / scripted reset)
  agentio vault clear --force`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !force {
				ok, err := host.NewPrompter(streams(cmd)).Confirm("This will delete all profiles, credentials, and API keys. Are you sure?")
				if err != nil {
					return err
				}
				if !ok {
					fmt.Fprintln(cmd.ErrOrStderr(), "Aborted")
					return nil
				}
			}
			if err := vault.Update(func(cur *vault.Contents) error {
				cur.Config = vault.Config{Profiles: vault.NewProfiles()}
				cur.Credentials = vault.NewCredentials()
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

// resolvePassphrase is Bun resolvePassphrase (src/vault/passphrase-input.ts):
// --passphrase-stdin, --passphrase, AGENTIO_PASSPHRASE verbatim, then a
// prompt on a terminal. create prompts for a new passphrase twice.
func resolvePassphrase(cmd *cobra.Command, flag string, fromStdin, create bool) (string, error) {
	if flag != "" && fromStdin {
		return "", clierr.New(clierr.InvalidParams, "--passphrase and --passphrase-stdin are mutually exclusive", "")
	}
	if fromStdin {
		raw, _, err := host.ReadStdin(cmd.InOrStdin())
		if err != nil {
			return "", err
		}
		// readStdin(): Buffer#toString('utf-8'), then String#trim.
		if piped := jsvalue.Trim(jsvalue.BufferString([]byte(raw))); piped != "" {
			return piped, nil
		}
		return "", clierr.New(clierr.InvalidParams, "No passphrase received on stdin",
			`Pipe it in, e.g. printf %s "$PW" | agentio vault set <path> --passphrase-stdin`)
	}
	if flag != "" {
		return flag, nil
	}
	if v := os.Getenv("AGENTIO_PASSPHRASE"); v != "" {
		return v, nil
	}
	if !host.IsTerminal(cmd.InOrStdin()) {
		return "", clierr.New(clierr.InvalidParams,
			"A passphrase is required and no terminal is available to prompt",
			"Use --passphrase-stdin, --passphrase <value>, or set AGENTIO_PASSPHRASE")
	}
	p := host.NewPrompter(streams(cmd))
	if !create {
		return p.Password("Vault passphrase:", nil)
	}
	// Bun promptNewPassphrase: a short one is asked again, not refused.
	pass, err := p.Password(fmt.Sprintf("Create a passphrase (min %d chars):", vault.MinPassphraseLen), func(v string) string {
		if err := vault.ValidatePassphrase(v); err != nil {
			return err.(*clierr.Error).Message
		}
		return ""
	})
	if err != nil {
		return "", err
	}
	again, err := p.Password("Confirm passphrase:", nil)
	if err != nil {
		return "", err
	}
	if pass != again {
		return "", clierr.New(clierr.InvalidParams, "Passphrases do not match", "")
	}
	return pass, nil
}

func randRead(b []byte) (int, error) { return rand.Read(b) }

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

func isAbs(path string) bool { return filepath.IsAbs(path) }

func joinPath(a, b string) string { return filepath.Join(a, b) }

// profileCount is the number of profile entries across services.
func profileCount(c *vault.Contents) int {
	n := 0
	for _, service := range c.Config.Profiles.Services() {
		n += len(c.Config.Profiles.Get(service))
	}
	return n
}

// findEntry is the index of the entry named name, -1 when none is.
func findEntry(list []vault.ProfileValue, name string) int {
	for i, p := range list {
		if p.Name == name {
			return i
		}
	}
	return -1
}

// selection is one profile picked for export.
type selection struct{ service, name string }

// exportBlob is Bun's export document for the selected profiles, in their
// order: profile entries are bare names, credentials go as stored, and
// read-only flags and API keys stay out.
func exportBlob(c *vault.Contents, selected []selection) string {
	profiles, credentials := jsvalue.NewObject(), jsvalue.NewObject()
	for _, sel := range selected {
		names, _ := profiles.Get(sel.service)
		list, _ := names.([]any)
		profiles.Set(sel.service, append(list, sel.name))
		if c.Credentials.Has(sel.service, sel.name) {
			byName, _ := credentials.Get(sel.service)
			obj, _ := byName.(*jsvalue.Object)
			if obj == nil {
				obj = jsvalue.NewObject()
				credentials.Set(sel.service, obj)
			}
			stored, _ := c.Credentials.Raw(sel.service, sel.name)
			obj.Set(sel.name, stored)
		}
	}
	config := jsvalue.NewObject()
	config.Set("profiles", profiles)
	body := jsvalue.NewObject()
	body.Set("version", 1)
	body.Set("config", config)
	body.Set("credentials", credentials)
	return string(jsvalue.Stringify(body))
}

var errUndecryptable = clierr.New(clierr.AuthFailed, "Failed to decrypt configuration", "Check that you are using the correct encryption key")

// decodeExport is Bun's JSON.parse of the decrypted export, inside the same
// try/catch as the decryption (text that is not JSON reads as a wrong key),
// then its `exportData.version !== 1` check.
func decodeExport(plain string) (*vault.Contents, error) {
	parsed, err := jsvalue.Parse([]byte(plain))
	if err != nil {
		return nil, errUndecryptable
	}
	if parsed == nil {
		return nil, errors.New("null is not an object (evaluating 'exportData.version')")
	}
	version := "undefined"
	if obj, ok := parsed.(*jsvalue.Object); ok {
		if v, ok := obj.Get("version"); ok {
			version = jsvalue.String(v)
			if n, isNum := v.(json.Number); isNum && jsvalue.Number(string(n)) == vault.CurrentVersion {
				version = ""
			}
		}
	}
	if version != "" {
		return nil, clierr.New(clierr.InvalidParams, "Unsupported export version: "+version, "This version of agentio may not support this export format")
	}
	dec := json.NewDecoder(strings.NewReader(plain))
	dec.UseNumber()
	var c vault.Contents
	if err := dec.Decode(&c); err != nil {
		return nil, clierr.New(clierr.InvalidParams, "Export is not valid JSON", "")
	}
	if c.Config.Profiles.Len() == 0 {
		c.Config.Profiles = vault.NewProfiles()
	}
	if len(c.Credentials.Services()) == 0 {
		c.Credentials = vault.NewCredentials()
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
