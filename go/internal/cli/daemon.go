package cli

import (
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/spf13/cobra"
)

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
