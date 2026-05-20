# pi-data360-browser

Interactive Data 360 browsers for pi.

This package is only the TUI layer. It requires the `sf-pi` package at runtime
and routes all Data 360 API calls through `sf-pi`'s `sf-data360` internals:

- cached `@salesforce/core` connection
- target-org resolution
- API-version resolution
- Data 360 REST path building
- `connRequest` execution

There is intentionally no `sf api request rest` fallback in this package.

## Commands

- `/d360-browser` - full-screen Data 360 API operation gallery
- `/d360-query-explorer` - DMO/DLO picker, field picker, SQL preview, results
- `/d360-query-browser` - alias for `/d360-query-explorer`
- `/d360-profile-explorer` - profile DMO picker and record browser
- `/d360-semantic-explorer` - vector search index explorer
- `/d360-data-graph-new` - Data Graph creation wizard
- `/d360-query-builder` - step-by-step DMO/DLO SQL builder
- `/d360-request` - prompted raw Data 360 request builder

## Runtime Dependency

Install `sf-pi` first:

```bash
pi install git:github.com/salesforce/sf-pi
```

By default the adapter looks for `sf-pi` at:

```text
~/.pi/agent/git/github.com/salesforce/sf-pi
```

For development, override that location:

```bash
export SF_DATA360_BROWSER_SFPI_PATH=/path/to/sf-pi
```

The commands use your Salesforce CLI default org by default. You can also pass
an alias as the first argument or set a package default:

```text
/d360-query-explorer my-sandbox
/d360-query-browser my-sandbox refresh
```

```bash
export SF_DATA360_BROWSER_DEFAULT_ORG=my-sandbox
```

## Install

From this package directory:

```bash
pi install .
```

Then reload pi and run:

```text
/d360-query-explorer
# or the compatibility alias:
/d360-query-browser
```

The explorer title bar shows `[transport: sf-data360 @ <sha>]` when it is using
the `sf-pi` conduit.
