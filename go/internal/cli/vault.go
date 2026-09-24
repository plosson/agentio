package cli

import (
	"fmt"
	"os"

	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

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
			fmt.Println("\nNext: agentio profile add <service>")
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
				for _, ref := range profile.ListProfileRefs(s, "") {
					ro := ""
					if ref.ReadOnly {
						ro = " [read-only]"
					}
					fmt.Printf("  %s/%s%s\n", ref.Service, ref.Name, ro)
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
