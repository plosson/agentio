package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/github"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

// addGitHubVaultSecretCommands is src/commands/github-vault-secrets.ts: the
// agentio-owned `github install|uninstall` commands. They read the whole vault,
// so they live in the host rather than in the github plugin.
func addGitHubVaultSecretCommands(root *cobra.Command, reg *plugins.Registry) {
	var gh *cobra.Command
	for _, c := range root.Commands() {
		if c.Name() == "github" {
			gh = c
		}
	}
	if gh == nil || reg.Find("github") == nil {
		return
	}
	gh.AddCommand(githubSecretCmd(reg, githubSecretSpec{
		use:       "install <repo>",
		short:     "Install AGENTIO_KEY and AGENTIO_CONFIG as GitHub Actions secrets",
		operation: "install secrets",
		example: `  # install secrets into a repo using the default github profile
  agentio github install octocat/hello-world

  # install secrets using a named profile
  agentio github install octocat/hello-world --profile work`,
		run: installSecrets,
	}))
	gh.AddCommand(githubSecretCmd(reg, githubSecretSpec{
		use:       "uninstall <repo>",
		short:     "Remove AGENTIO_KEY and AGENTIO_CONFIG secrets from a repository",
		operation: "uninstall secrets",
		example: `  # remove the agentio secrets from a repo
  agentio github uninstall octocat/hello-world

  # uninstall using a named profile
  agentio github uninstall octocat/hello-world --profile work`,
		run: uninstallSecrets,
	}))
}

type githubSecretSpec struct {
	use, short, operation, example string
	run                            func(cmd *cobra.Command, client *github.Client, profileName, repo string) error
}

func githubSecretCmd(reg *plugins.Registry, spec githubSecretSpec) *cobra.Command {
	var profileFlag string
	cmd := &cobra.Command{
		Use:     spec.use,
		Short:   spec.short,
		Example: spec.example,
		RunE: func(cmd *cobra.Command, args []string) error {
			repo := args[0]
			if err := assertRepo(repo); err != nil {
				return err
			}
			ctx := context.Background()
			name, err := profile.Require("github", profileFlag)
			if err != nil {
				return err
			}
			fresh, err := auth.GetFresh(ctx, reg, "github", name, auth.RefreshOptions{})
			if err != nil {
				return err
			}
			if err := host.EnforceWrite("github", name, spec.operation); err != nil {
				return err
			}
			client := github.NewClient(ctx, host.NewRunContext(fresh.Credentials, name, ctx))
			return spec.run(cmd, client, name, repo)
		},
	}
	describeArgument(cmd, "repo", "Repository in owner/repo format")
	cmd.Flags().StringVar(&profileFlag, "profile", "", "Profile name (optional if only one profile exists)")
	return cmd
}

func assertRepo(repo string) error {
	parts := strings.Split(repo, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return clierr.New(clierr.InvalidParams,
			`Invalid repository format: "`+repo+`"`,
			"Use the format: owner/repo (e.g., octocat/hello-world)")
	}
	return nil
}

func installSecrets(cmd *cobra.Command, client *github.Client, profileName, repo string) error {
	stderr, stdout := cmd.ErrOrStderr(), cmd.OutOrStdout()
	fmt.Fprintf(stderr, "Using GitHub profile: %s\n", profileName)
	fmt.Fprintf(stderr, "Installing secrets to: %s\n", repo)
	key, config, err := generateExportData()
	if err != nil {
		return err
	}
	fmt.Fprintln(stderr, "\nSetting AGENTIO_KEY...")
	if err := client.SetRepoSecret(repo, "AGENTIO_KEY", key); err != nil {
		return err
	}
	fmt.Fprintln(stderr, "Setting AGENTIO_CONFIG...")
	if err := client.SetRepoSecret(repo, "AGENTIO_CONFIG", config); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "\nInstalled AGENTIO_KEY and AGENTIO_CONFIG to %s\n", repo)
	fmt.Fprintln(stdout, "\nIn your GitHub Actions workflow, use:")
	fmt.Fprintln(stdout, "  env:")
	fmt.Fprintln(stdout, "    AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}")
	fmt.Fprintln(stdout, "    AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}")
	return nil
}

func uninstallSecrets(cmd *cobra.Command, client *github.Client, profileName, repo string) error {
	stderr := cmd.ErrOrStderr()
	fmt.Fprintf(stderr, "Using GitHub profile: %s\n", profileName)
	fmt.Fprintf(stderr, "Removing secrets from: %s\n", repo)
	fmt.Fprintln(stderr, "\nDeleting AGENTIO_KEY...")
	if err := client.DeleteRepoSecret(repo, "AGENTIO_KEY"); err != nil {
		return err
	}
	fmt.Fprintln(stderr, "Deleting AGENTIO_CONFIG...")
	if err := client.DeleteRepoSecret(repo, "AGENTIO_CONFIG"); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "\nRemoved AGENTIO_KEY and AGENTIO_CONFIG from %s\n", repo)
	return nil
}

// generateExportData is Bun's: a fresh key and the whole vault (config as
// stored, every credential) encrypted with it. Unlike `vault export`, the
// config is not reduced to profile names.
func generateExportData() (string, string, error) {
	if err := auth.AssertLocal("Reading the vault"); err != nil {
		return "", "", err
	}
	buf := make([]byte, 32)
	if _, err := randRead(buf); err != nil {
		return "", "", err
	}
	key := hexEncode(buf)
	contents, err := vault.Load()
	if err != nil {
		return "", "", err
	}
	// Bun: JSON.stringify({ version: 1, config, credentials }).
	raw := jsvalue.Stringify(jsvalue.ObjectOf("version", 1, "config", contents.Config, "credentials", contents.Credentials))
	enc, err := vault.Encrypt(string(raw), key)
	if err != nil {
		return "", "", err
	}
	return key, enc, nil
}
