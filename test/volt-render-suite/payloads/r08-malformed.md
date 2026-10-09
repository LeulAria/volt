This paragraph has **unclosed bold and *unclosed italic

A list that changes markers mid-way:
- one
* two
1. three

| broken | table
|---|
| only one cell |
| a | b | c | d |

<details><summary>Raw HTML details</summary>

Hidden content with **markdown** inside.

</details>

<script>alert('xss')</script>

<img src=x onerror="alert(1)">

[link with no closing paren](https://example.com

```mermaid
flowchart TD
  A --> B
  B --> 
```

```python
def unterminated():
    return "this fence never closes"
