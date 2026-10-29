# Use cases

Web MCP lets your AI assistant use a real browser. Here are ways to put it to work. Just ask in plain language; the AI picks the right tools.

## Browse the web

Ask your AI to go to a website and get information from it.

- "Find the latest news about space exploration."
- "Check the price of this product on the shop's website."
- "Read the documentation page for this library and summarise the setup steps."

The AI opens its own tab, reads the page and tells you what it found. You can watch it work.

## Fill out forms

Your AI can fill in text fields, choose options in dropdowns, tick checkboxes and submit forms.

- "Fill out this contact form with my details."
- "Sign up for the newsletter on this site with my work email."
- "Open a support ticket with this description."

The tab is covered by an overlay while the AI types, so your clicks don't interfere, and pressing Enter still submits the form. Logs and recordings never contain what it typed, and values typed into password-like fields aren't shown in the side panel either.

## Test websites and apps

If you are building a web app, ask your AI to try it the way a user would.

- "Open http://localhost:3000 and go through the checkout flow. Tell me if anything breaks."
- "Test the search box and check that results show up."
- "Check every link in the footer of the homepage."
- "Open the signup page in an isolated tab and check it works when logged out."

The AI is instructed to open only the starting page directly and then click and type its way through, like a real user, instead of jumping to URLs. For local files, serve them over HTTP (for example `npx http-server`). Web MCP doesn't open `file://` URLs. Your app can run on any local port except Web MCP's own (3026 and 9222 by default).

## Extract data

The AI can read a page and organise what is on it.

- "Go to this list of job postings and make a table of the first 10 results."
- "Check the weather forecast for this week and summarise it."
- "Read the top stories on this news site and give me a summary."

## Check dashboards and accounts

Log in once in the Web MCP browser (run `web-mcp browser` and sign in), then ask:

- "Open my analytics dashboard and tell me today's numbers."
- "Look at my order history and tell me when my last order was."
- "Open the project board and list all incomplete tasks in the current sprint."

Every AI chat that uses Web MCP shares those logins. Only log in to what you're comfortable letting your AI use, and keep sensitive sites out with `blockedUrlPatterns` (see [Security](security.md#recommendations)).

## Chain several steps

Combine several steps into one request.

- "Go to google.com, search for the best laptops under 1000 dollars, open the first review, and summarise it."
- "Log in to the admin panel, export last week's report, and tell me the totals."
- "Find a pasta recipe on this site, read the ingredients, and write them down as a shopping list."

## Tips

- **Name your agents** when you run several: "Call browser_start with agentName 'Research'." The name appears on the overlay and in the side panel.
- **Ask the AI to finish with `browser_done`** if it leaves the overlay up. It is told to do this anyway.
- **Ask it to close its tabs** with `browser_stop` when a long session is over.
- **Watch the side panel** for what each agent is doing and its last few actions.
