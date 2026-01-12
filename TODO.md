# Pending ideas or tasks

- [twitter] Integration with Twitter API to be able to post or read tweets
- [threads] Integration with Threads API to be able to post or read messages
- [linkedin] Integration with LinkedIn API to be able to post or read messages
- [instagram] Integration with Instagram API to be able to post or read messages
- [tiktok] Integration with TikTok API to be able to post or read messages
- [confluence] Integration with Confluence (Atlassian) API to be able to post or read tweets (we already have a jira
  implementation)
- [discord] Integration with Discord API to be able to post or read messages (we have a telegram implementation)
-

For each of the ideas above, analyze the feasibility of it by performing a deep internet research (with recent sources
from the past 6 month maximum) on what is possible using the vendor's API and the authentication requirements (creation
of an Agentio app for oauth, what scopes are required). You can write the result to docs/<vendor>_analysis.md eg.
docs/twitter_analysis.md

Once the analysis is done, if you consider something can be implemented (please do not implement if you feel there
is no way to perform what would be needed), create a full implementation task breakdown in docs/<vendor>_tasks.md
listing all the steps needed to implement the feature.
