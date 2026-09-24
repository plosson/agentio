package gmail

import (
        "context"
        "fmt"

        "github.com/plosson/agentio/go/internal/oauth"
        "google.golang.org/api/gmail/v1"
        "google.golang.org/api/option"
)

type Client struct {
        svc *gmail.Service
}

func NewClient(ctx context.Context, bundle *oauth.TokenBundle) (*Client, error) {
        ts, err := oauth.TokenSource(ctx, bundle)
        if err != nil {
                return nil, err
        }
        svc, err := gmail.NewService(ctx, option.WithTokenSource(ts))
        if err != nil {
                return nil, err
        }
        return &Client{svc: svc}, nil
}

type Profile struct {
        EmailAddress  string
        MessagesTotal int64
        ThreadsTotal  int64
}

func (c *Client) GetProfile(ctx context.Context) (*Profile, error) {
        p, err := c.svc.Users.GetProfile("me").Context(ctx).Do()
        if err != nil {
                return nil, err
        }
        return &Profile{
                EmailAddress:  p.EmailAddress,
                MessagesTotal: p.MessagesTotal,
                ThreadsTotal:  p.ThreadsTotal,
        }, nil
}

type Label struct {
        ID   string
        Name string
        Type string
}

func (c *Client) ListLabels(ctx context.Context) ([]Label, error) {
        res, err := c.svc.Users.Labels.List("me").Context(ctx).Do()
        if err != nil {
                return nil, err
        }
        out := make([]Label, 0, len(res.Labels))
        for _, l := range res.Labels {
                out = append(out, Label{ID: l.Id, Name: l.Name, Type: l.Type})
        }
        return out, nil
}

func FormatLabels(labels []Label) string {
        s := fmt.Sprintf("%d labels\n", len(labels))
        for _, l := range labels {
                s += fmt.Sprintf("  %s\t%s\t%s\n", l.Type, l.ID, l.Name)
        }
        return s
}
