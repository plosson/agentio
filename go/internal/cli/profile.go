package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/service"
	"github.com/spf13/cobra"
)

func profileCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profile",
		Short: "Manage profiles across services (shared registry — Bun profile commands)",
	}
	known := func() string { return strings.Join(service.Default.Names(), ", ") }

	listCmd := &cobra.Command{
		Use:   "list [service]",
		Short: "List configured profiles (Bun profile list / listProfileRefs)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := openStore()
			if err != nil {
				return err
			}
			filter := ""
			if len(args) == 1 {
				filter = args[0]
				if !service.Default.Has(filter) {
					return fmt.Errorf("unknown service: %q (known: %s)", filter, known())
				}
			}
			refs := profile.ListProfileRefs(s, filter)
			if len(refs) == 0 {
				fmt.Println("No profiles configured.")
				fmt.Println("Add one with: agentio profile add <service>")
				return nil
			}
			by := map[string][]profile.ProfileRef{}
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
		Short: "Add a profile (plugin Setup → host SaveProfile; Bun addProfileFromPlugin)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return addProfileForService(cmd.Context(), args[0], profileName, readOnly)
		},
	}
	addCmd.Flags().StringVar(&profileName, "profile", "", "Profile name")
	addCmd.Flags().BoolVar(&readOnly, "read-only", false, "Create as read-only profile")

	removeCmd := &cobra.Command{
		Use:   "remove <service> <name>",
		Short: "Remove a profile (Bun deleteProfile)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			svc, name := args[0], args[1]
			if !service.Default.Has(svc) {
				return fmt.Errorf("unknown service: %q (known: %s)", svc, known())
			}
			s, err := openStore()
			if err != nil {
				return err
			}
			ok, err := profile.DeleteProfile(s, svc, name)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("profile %q not found for %s", name, svc)
			}
			fmt.Printf("Removed profile %q\n", name)
			return nil
		},
	}

	renameCmd := &cobra.Command{
		Use:   "rename <service> <name> <new-name>",
		Short: "Rename a profile (Bun renameProfile)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			svc, from, to := args[0], args[1], args[2]
			if !service.Default.Has(svc) {
				return fmt.Errorf("unknown service: %q (known: %s)", svc, known())
			}
			s, err := openStore()
			if err != nil {
				return err
			}
			outcome, err := profile.RenameProfile(s, svc, from, to)
			if err != nil {
				return err
			}
			switch outcome {
			case profile.WriteOK:
				fmt.Printf("Renamed profile %q to %q\n", from, to)
				return nil
			case profile.WriteAbsent:
				return fmt.Errorf("profile %q not found for %s", from, svc)
			case profile.WriteTaken:
				return fmt.Errorf("profile %q already exists for %s", to, svc)
			default:
				return fmt.Errorf("rename failed: %s", outcome)
			}
		},
	}

	cmd.AddCommand(listCmd, addCmd, removeCmd, renameCmd)
	return cmd
}

// addProfileForService is the host path: registry Find → AddProfileFromPlugin.
func addProfileForService(ctx context.Context, serviceID, explicitName string, readOnly bool) error {
	plugin, ok := service.Default.Find(serviceID)
	if !ok {
		return fmt.Errorf("unknown service: %q (known: %s)", serviceID, strings.Join(service.Default.Names(), ", "))
	}
	s, err := openStore()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()

	name, result, err := profile.AddProfileFromPlugin(ctx, s, plugin, service.SetupOptions{
		Profile:  explicitName,
		ReadOnly: readOnly,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Profile %q configured!\n", name)
	if result != nil && result.Info != "" {
		fmt.Println(result.Info)
	}
	if readOnly {
		fmt.Println("Access: read-only")
	}
	return nil
}
