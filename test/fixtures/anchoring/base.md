# Field notes on river otters

These notes were written during three weeks of observation on the lower river. They describe what the otters did, when they did it, and what we think it means. The notes are meant for readers who have never seen an otter in the wild.

## Morning routine

Every morning the otters leave the holt before sunrise and swim upstream to the gravel bar. The oldest female leads the group and the cubs follow her closely. On cold mornings they stay in the water for less than an hour, and on warm mornings they may fish until noon.

The quick brown fox jumps over the lazy dog while the otters watch from the far bank. This sentence is here because every test document needs it. The otters did not seem to mind the fox at all.

Every morning the otters leave a small mark on the flat stone near the ford. Every morning the otters check that mark before they do anything else. We counted the visits for nineteen days in a row.

![A sample picture](../images/sample.png)

The picture above shows the gravel bar at low water. The dark patch in the middle is where the otters usually eat.

## What they eat

- [x] Small fish, mostly minnows and young trout
- [x] Crayfish from under the flat stones
- [ ] Frogs, which we never saw them catch
- [ ] Freshwater mussels, mentioned by other observers

> [!NOTE]
> The diet changes with the season. In late summer the otters eat far more crayfish than fish.

The numbers below come from the daily counts[^counts]. A second source[^other] gives slightly lower figures for the same stretch of river.

| Day | Fish caught | Crayfish caught | Remarks |
|-----|------------:|----------------:|---------|
| 1 | 12 | 3 | Clear water, no wind |
| 2 | 9 | 5 | Light rain in the morning |
| 3 | 14 | 2 | Two cubs fishing alone |
| 4 | 7 | 8 | Water rising after the storm |
| 5 | 11 | 4 | Clear water, no wind |
| 6 | 10 | 6 | A heron on the gravel bar |
| 7 | 13 | 3 | Clear water, light wind |
| 8 | 8 | 7 | Muddy water all day |
| 9 | 15 | 1 | The best day of the first half |
| 10 | 6 | 9 | Crayfish under every stone |
| 11 | 12 | 4 | Cold morning, short visit |
| 12 | 9 | 6 | A dog on the far bank |
| 13 | 14 | 2 | Clear water, no wind |
| 14 | 10 | 5 | Cubs playing more than fishing |
| 15 | 11 | 4 | Water falling slowly |
| 16 | 13 | 3 | First frost on the grass |
| 17 | 7 | 8 | Fog until ten |
| 18 | 12 | 5 | Clear water, light wind |
| 19 | 16 | 2 | The best day of all |

## How we counted

The count for one morning is the sum over all animals, so the mean per animal is

$$
\bar{c} = \frac{1}{n} \sum_{i=1}^{n} c_i
$$

where the group size $n$ was five on most days.

```python
def mean_catch(counts):
    """Mean catch per animal for one morning."""
    return sum(counts) / len(counts)
```

```mermaid
flowchart LR
    Holt[Leave the holt] --> Bar[Gravel bar]
    Bar --> Fish[Fishing]
    Fish --> Rest[Rest on the bank]
```

The diagram shows a typical morning from the holt to the resting place. The arrows give the order, not the distance.

## Afternoon and evening

In the afternoon the otters rest in the reeds on the eastern bank. The cubs sleep in a heap and the adults take turns to keep watch. Nothing much happens until the light begins to fade, and then the whole group moves down to the pool below the weir, where the water is deep and slow and the big trout lie. This is the part of the day we know least about, because the pool is hard to see from the path and the evening light is poor, so most of what we wrote down here comes from sounds and from the tracks we found the next morning on the sand at the edge of the pool, which told us roughly how many animals had been there and for how long they stayed.

The evening visits to the pool became shorter as the nights grew colder. By the end of the third week the otters were back in the holt before dark.

## Closing remarks

Three weeks are not enough to say anything certain. Still, the pattern was the same on almost every day, and the few exceptions had an obvious cause such as rain, a dog or a boat.

We hope to return in spring and repeat the counts with the same method. The quick brown fox will probably be there again.

[^counts]: Counted by two observers from the path, between first light and noon.
[^other]: Field survey of the river authority, unpublished.
