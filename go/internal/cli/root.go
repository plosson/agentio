package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

const Version = "0.0.0-go-skeleton"

func NewRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "agentio",
		Short:         "AgentIO Go port skeleton (vault + daemon + profile + gmail)",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(versionCmd(), vaultCmd(), daemonCmd(), profileCmd(), gmailCmd())
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

func openStore() (*vault.Store, error) {
	pw, err := vault.ResolvePassphrase()
	if err != nil {
		return nil, err
	}
	return vault.Open(pw)
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
