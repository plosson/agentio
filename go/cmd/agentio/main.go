package main

import (
        "fmt"
        "os"

        "github.com/plosson/agentio/go/internal/cli"
)

func main() {
        if err := cli.NewRoot().Execute(); err != nil {
                fmt.Fprintln(os.Stderr, "Error:", err)
                os.Exit(1)
        }
}
