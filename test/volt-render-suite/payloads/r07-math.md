The softmax of a vector $z \in \mathbb{R}^K$ is $\sigma(z)_i = \frac{e^{z_i}}{\sum_{j=1}^{K} e^{z_j}}$.

Display math:

$$
\mathcal{L}(\theta) = -\frac{1}{N}\sum_{n=1}^{N} \sum_{k=1}^{K} y_{n,k} \log \hat{y}_{n,k}(\theta) + \lambda \lVert \theta \rVert_2^2
$$

And a matrix:

$$
A = \begin{bmatrix} 1 & 2 & 3 \\ 4 & 5 & 6 \\ 7 & 8 & 9 \end{bmatrix}
$$
