package cli

import (
	"context"
	"fmt"

	"github.com/plosson/agentio/go/internal/profile"
	jirasvc "github.com/plosson/agentio/go/internal/services/jira"
	"github.com/spf13/cobra"
)

// jiraCmd registers Jira API commands only. Profile CRUD is under
// `agentio profile …`. Per-service `jira profile add|list` remain as
// Bun-compatible shims that call the same AddProfileFromPlugin host path.
func jiraCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "jira", Short: "Jira operations (Go skeleton)"}
	var profileFlag string

	pCmd := &cobra.Command{Use: "profile", Short: "Manage Jira profiles (delegates to shared profile layer)"}
	pCmd.PersistentFlags().StringVar(&profileFlag, "profile", "", "Profile name (defaults to site hostname)")
	pCmd.AddCommand(&cobra.Command{
		Use:   "add",
		Short: "Add a Jira profile via Atlassian OAuth (shim → agentio profile add jira)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return addProfileForService(cmd.Context(), jirasvc.ServiceID, profileFlag, false)
		},
	})
	pCmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List Jira profiles (shim → profile.ListProfiles)",
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := openStore()
			if err != nil {
				return err
			}
			groups := profile.ListProfiles(s, jirasvc.ServiceID)
			if len(groups) == 0 || len(groups[0].Profiles) == 0 {
				fmt.Println("No Jira profiles configured.")
				fmt.Println("Run: agentio profile add jira")
				return nil
			}
			for _, p := range groups[0].Profiles {
				ro := ""
				if p.ReadOnly {
					ro = " [read-only]"
				}
				fmt.Printf("%s%s\n", p.Name, ro)
			}
			return nil
		},
	})

	myself := &cobra.Command{
		Use:   "myself",
		Short: "Show the authenticated Jira user (GET /myself)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, name, err := jiraAPIClient(cmd.Context(), profileFlag)
			if err != nil {
				return err
			}
			me, err := client.Myself(cmd.Context())
			if err != nil {
				return err
			}
			fmt.Printf("CLI profile: %s\nDisplay: %s\nEmail: %s\nAccount: %s\n", name, me.DisplayName, me.Email, me.AccountID)
			return nil
		},
	}
	myself.Flags().StringVar(&profileFlag, "profile", "", "Profile name")

	projects := &cobra.Command{
		Use:   "projects",
		Short: "List Jira projects (GET /project/search)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, name, err := jiraAPIClient(cmd.Context(), profileFlag)
			if err != nil {
				return err
			}
			list, err := client.ListProjects(cmd.Context(), 50)
			if err != nil {
				return err
			}
			fmt.Printf("Profile: %s\n%s", name, jirasvc.FormatProjects(list))
			return nil
		},
	}
	projects.Flags().StringVar(&profileFlag, "profile", "", "Profile name")

	cmd.AddCommand(pCmd, myself, projects)
	return cmd
}

func jiraAPIClient(ctx context.Context, profileFlag string) (*jirasvc.Client, string, error) {
	s, err := openStore()
	if err != nil {
		return nil, "", err
	}
	name, err := profile.RequireProfile(s, jirasvc.ServiceID, profileFlag)
	if err != nil {
		return nil, "", err
	}
	creds, err := profile.GetCredentials(s, jirasvc.ServiceID, name)
	if err != nil {
		return nil, "", err
	}
	return jirasvc.ClientFromCredentials(creds), name, nil
}
