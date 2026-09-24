package cli

import (
	"context"
	"fmt"

	"github.com/plosson/agentio/go/internal/profile"
	gmailsvc "github.com/plosson/agentio/go/internal/plugins/gmail"
	"github.com/spf13/cobra"
)

// gmailCmd registers Gmail API commands only. Profile CRUD is under
// `agentio profile …`. Per-service `gmail profile add|list` remain as
// Bun-compatible shims that call the same AddProfileFromPlugin host path.
func gmailCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "gmail", Short: "Gmail operations (Go skeleton)"}
	var profileFlag string

	pCmd := &cobra.Command{Use: "profile", Short: "Manage Gmail profiles (delegates to shared profile layer)"}
	pCmd.PersistentFlags().StringVar(&profileFlag, "profile", "", "Profile name (defaults to Google email)")
	pCmd.AddCommand(&cobra.Command{
		Use:   "add",
		Short: "Add a Gmail profile via OAuth (shim → agentio profile add gmail)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return addProfileForService(cmd.Context(), gmailsvc.ServiceID, profileFlag, false)
		},
	})
	pCmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List Gmail profiles (shim → profile.ListProfiles)",
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := openStore()
			if err != nil {
				return err
			}
			groups := profile.ListProfiles(s, gmailsvc.ServiceID)
			var entries []struct {
				Name     string
				ReadOnly bool
			}
			if len(groups) > 0 {
				for _, p := range groups[0].Profiles {
					entries = append(entries, struct {
						Name     string
						ReadOnly bool
					}{p.Name, p.ReadOnly})
				}
			}
			if len(entries) == 0 {
				fmt.Println("No Gmail profiles configured.")
				fmt.Println("Run: agentio profile add gmail")
				return nil
			}
			for _, p := range entries {
				ro := ""
				if p.ReadOnly {
					ro = " [read-only]"
				}
				fmt.Printf("%s%s\n", p.Name, ro)
			}
			return nil
		},
	})

	labelsCmd := &cobra.Command{Use: "labels", Short: "Gmail labels"}
	labelsCmd.PersistentFlags().StringVar(&profileFlag, "profile", "", "Profile name")
	labelsCmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List labels",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, name, err := gmailAPIClient(cmd.Context(), profileFlag)
			if err != nil {
				return err
			}
			labels, err := client.ListLabels(cmd.Context())
			if err != nil {
				return err
			}
			fmt.Printf("Profile: %s\n%s", name, gmailsvc.FormatLabels(labels))
			return nil
		},
	})

	whoami := &cobra.Command{
		Use:   "profile-info",
		Short: "Show Gmail mailbox profile (users.getProfile)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, name, err := gmailAPIClient(cmd.Context(), profileFlag)
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
	whoami.Flags().StringVar(&profileFlag, "profile", "", "Profile name")

	cmd.AddCommand(pCmd, labelsCmd, whoami)
	return cmd
}

func gmailAPIClient(ctx context.Context, profileFlag string) (*gmailsvc.Client, string, error) {
	s, err := openStore()
	if err != nil {
		return nil, "", err
	}
	name, err := profile.RequireProfile(s, gmailsvc.ServiceID, profileFlag)
	if err != nil {
		return nil, "", err
	}
	creds, err := profile.GetCredentials(s, gmailsvc.ServiceID, name)
	if err != nil {
		return nil, "", err
	}
	client, err := gmailsvc.ClientFromCredentials(ctx, creds)
	return client, name, err
}
