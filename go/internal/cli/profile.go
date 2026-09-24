package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/profile"
	gmailsvc "github.com/plosson/agentio/go/internal/services/gmail"
	"github.com/spf13/cobra"
)

func profileCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profile",
		Short: "Manage profiles across services (shared registry)",
	}
	known := strings.Join(profile.KnownServices, ", ")

	listCmd := &cobra.Command{
		Use:   "list [service]",
		Short: "List configured profiles",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := openStore()
			if err != nil {
				return err
			}
			filter := ""
			if len(args) == 1 {
				filter = args[0]
				if !profile.IsKnown(filter) {
					return fmt.Errorf("unknown service: %q (known: %s)", filter, known)
				}
			}
			refs := profile.ListAll(s, filter)
			if len(refs) == 0 {
				fmt.Println("No profiles configured.")
				fmt.Println("Add one with: agentio profile add <service>")
				return nil
			}
			by := map[string][]profile.Ref{}
			order := []string{}
			for _, r := range refs {
				if _, ok := by[r.Service]; !ok {
					order = append(order, r.Service)
				}
				by[r.Service] = append(by[r.Service], r)
			}
			for _, svc := range order {
				fmt.Printf("%s:\n", svc)
				for _, p := range by[svc] {
					ro := ""
					if p.ReadOnly {
						ro = " [read-only]"
					}
					fmt.Printf("  %s%s\n", p.Name, ro)
				}
			}
			return nil
		},
	}

	var profileName string
	var readOnly bool
	addCmd := &cobra.Command{
		Use:   "add <service>",
		Short: "Add a profile for a service (service runs OAuth; profile layer stores)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			service := args[0]
			if !profile.IsKnown(service) {
				return fmt.Errorf("unknown service: %q (known: %s)", service, known)
			}
			return addProfileForService(cmd.Context(), service, profileName, readOnly)
		},
	}
	addCmd.Flags().StringVar(&profileName, "profile", "", "Profile name")
	addCmd.Flags().BoolVar(&readOnly, "read-only", false, "Create as read-only profile")

	removeCmd := &cobra.Command{
		Use:   "remove <service> <name>",
		Short: "Remove a profile",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			service, name := args[0], args[1]
			if !profile.IsKnown(service) {
				return fmt.Errorf("unknown service: %q (known: %s)", service, known)
			}
			s, err := openStore()
			if err != nil {
				return err
			}
			ok, err := profile.Remove(s, service, name)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("profile %q not found for %s", name, service)
			}
			fmt.Printf("Removed profile %q\n", name)
			return nil
		},
	}

	cmd.AddCommand(listCmd, addCmd, removeCmd)
	return cmd
}

func addProfileForService(ctx context.Context, service, explicitName string, readOnly bool) error {
	s, err := openStore()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()

	var result profile.SetupResult
	switch service {
	case gmailsvc.ServiceKey:
		result, err = gmailsvc.Setup(ctx)
	default:
		return fmt.Errorf("no profile setup for %s", service)
	}
	if err != nil {
		return err
	}
	result.ReadOnly = readOnly
	name, err := profile.PersistSetup(s, service, result, explicitName)
	if err != nil {
		return err
	}
	fmt.Printf("Profile %q configured!\n", name)
	if result.Info != "" {
		fmt.Println(result.Info)
	}
	if readOnly {
		fmt.Println("Access: read-only")
	}
	return nil
}
